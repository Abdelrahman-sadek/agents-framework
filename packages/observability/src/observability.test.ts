import { InMemoryEventSink, createRuntime, defineAgent, sequentialIds } from "@agent-framework/core";
import { createScriptedProvider } from "@agent-framework/core/testing";
import { ToolRuntime, defineTool } from "@agent-framework/tools";
import type { Tracer } from "@opentelemetry/api";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { CostTracker } from "./cost.js";
import { formatRunReport, inspectRun } from "./inspect.js";
import { openTelemetrySink } from "./otel.js";
import { fileEventSink, logSink, readEventFile, redactValue, redactingSink } from "./sinks.js";

interface FakeSpan {
  name: string;
  attributes: Record<string, unknown>;
  events: { name: string; attributes?: Record<string, unknown> }[];
  status?: { code: number; message?: string };
  ended: boolean;
}

function fakeTracer() {
  const spans: FakeSpan[] = [];
  const wrap = (span: FakeSpan) => ({
    __fake: span,
    setAttribute: (k: string, v: unknown) => ((span.attributes[k] = v), undefined),
    setAttributes: (a: Record<string, unknown>) => (Object.assign(span.attributes, a), undefined),
    addEvent: (name: string, attributes?: Record<string, unknown>) => span.events.push({ name, ...(attributes === undefined ? {} : { attributes }) }),
    setStatus: (s: { code: number; message?: string }) => (span.status = s),
    updateName: (n: string) => (span.name = n),
    end: () => (span.ended = true),
    spanContext: () => ({ traceId: "t", spanId: String(spans.indexOf(span)), traceFlags: 1 }),
    isRecording: () => true,
    recordException: () => undefined,
  });
  const tracer = {
    startSpan(name: string, options?: { attributes?: Record<string, unknown> }) {
      const span: FakeSpan = { name, attributes: { ...options?.attributes }, events: [], ended: false };
      spans.push(span);
      return wrap(span);
    },
  };
  return { tracer: tracer as unknown as Tracer, spans };
}

async function runAgent() {
  const sink = new InMemoryEventSink();
  const provider = createScriptedProvider(
    [{ toolCalls: [{ id: "c1", name: "lookup", arguments: { email: "jane@acme.com" } }], usage: { inputTokens: 100, outputTokens: 20 } }, { text: "Found it.", usage: { inputTokens: 150, outputTokens: 10 } }],
    { capabilities: { pricing: { currency: "USD", inputPerMillionTokens: 2, outputPerMillionTokens: 8 } } },
  );
  const lookup = defineTool({ name: "lookup", description: "d", input: z.object({ email: z.string() }), execute: async () => ({ found: true }) });
  const runtime = createRuntime({ providers: [provider], tools: new ToolRuntime(), events: sink, ids: sequentialIds() });
  const agent = defineAgent({ name: "support", model: { providerId: "scripted", modelId: "m-1" }, tools: [lookup], runtime });
  const result = await agent.run({ input: "find jane", user: { userId: "u1", tenantId: "acme" } });
  return { result, events: sink.events };
}

describe("OpenTelemetry bridge", () => {
  test("creates a run span with step spans and GenAI attributes", async () => {
    const { events } = await runAgent();
    const { tracer, spans } = fakeTracer();
    const sink = openTelemetrySink({ tracer });
    for (const e of events) sink.emit(e);
    const run = spans.find((s) => s.name === "agent.run support");
    expect(run).toMatchObject({ ended: true, attributes: { "agent.status": "COMPLETED", "enduser.tenant_id": "acme" }, status: { code: 1 } });
    const llm = spans.filter((s) => s.name === "gen_ai.chat m-1");
    expect(llm).toHaveLength(2);
    expect(llm[0]?.attributes).toMatchObject({ "gen_ai.system": "scripted", "gen_ai.usage.input_tokens": 100, "gen_ai.usage.output_tokens": 20 });
    const tool = spans.find((s) => s.name === "agent.tool lookup");
    expect(tool?.attributes["gen_ai.tool.name"]).toBe("lookup");
    expect(spans.every((s) => s.ended)).toBe(true);
    expect(JSON.stringify(spans)).not.toContain("jane@acme.com");
  });

  test("failed runs mark the span as an error", async () => {
    const provider = createScriptedProvider([{ error: new Error("down") }]);
    const sink = new InMemoryEventSink();
    const runtime = createRuntime({ providers: [provider], events: sink });
    await defineAgent({ name: "a", model: { providerId: "scripted", modelId: "m" }, runtime }).run({ input: "x" });
    const { tracer, spans } = fakeTracer();
    const otel = openTelemetrySink({ tracer });
    for (const e of sink.events) otel.emit(e);
    expect(spans[0]?.status).toMatchObject({ code: 2, message: "LLM_ERROR: down" });
  });
});

describe("cost tracking and inspection", () => {
  test("aggregates tokens and cost by agent, model, tenant and user", async () => {
    const { events } = await runAgent();
    const tracker = new CostTracker();
    for (const e of events) tracker.emit(e);
    const report = tracker.report();
    expect(report.total).toMatchObject({ llmCalls: 2, inputTokens: 250, outputTokens: 30 });
    expect(report.total.costUsd).toBeCloseTo((250 * 2 + 30 * 8) / 1e6);
    expect(report.byTenant[0]?.key).toBe("acme");
    expect(report.byModel[0]?.key).toBe("scripted/m-1");
  });

  test("inspectRun reconstructs the run", async () => {
    const { events } = await runAgent();
    const report = inspectRun(events);
    expect(report).toMatchObject({ status: "COMPLETED", llmCalls: 2, tokens: { input: 250, output: 30 }, toolCalls: [{ toolName: "lookup", outcome: "completed", attempts: 1 }] });
    const text = formatRunReport(report);
    expect(text).toContain("status=COMPLETED");
    expect(text).toContain("TOOL_EXECUTION_COMPLETED");
  });
});

describe("logs and redaction", () => {
  test("redactingSink scrubs emails, keys and dropped fields", () => {
    expect(redactValue({ a: "mail jane@acme.com", b: { secret: "x", token: "sk-abcdefghijklmnopqrstu" } }, { dropKeys: ["secret"] })).toEqual({
      a: "mail [REDACTED]",
      b: { secret: "[REDACTED]", token: "[REDACTED]" },
    });
    const inner = new InMemoryEventSink();
    redactingSink(inner).emit({ eventId: "e", sequence: 1, runId: "r", agentId: "a", occurredAt: "t", type: "AGENT_CANCELLED", payload: { reason: "by jane@acme.com" } });
    expect(inner.events[0]?.payload).toEqual({ reason: "by [REDACTED]" });
  });

  test("logSink writes JSON lines; file sink round-trips for tracing", async () => {
    const lines: string[] = [];
    const { events } = await runAgent();
    const log = logSink({ write: (l) => lines.push(l), types: ["AGENT_COMPLETED"] });
    for (const e of events) log.emit(e);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ level: "info", type: "AGENT_COMPLETED" });

    const path = join(mkdtempSync(join(tmpdir(), "af-")), "events.jsonl");
    const file = fileEventSink(path);
    for (const e of events) file.emit(e);
    expect(readEventFile(path, events[0]?.runId)).toHaveLength(events.length);
    expect(readEventFile(path, "other")).toHaveLength(0);
  });
});
