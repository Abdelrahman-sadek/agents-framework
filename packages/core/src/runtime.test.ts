import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { defineAgent, type AgentConfig } from "./agent.js";
import type { ContextAssemblyRequest, ContextManager } from "./context.js";
import { ConfigurationError, LLMError, ValidationError } from "./errors.js";
import { InMemoryEventSink } from "./events.js";
import { createRuntime, type RuntimeOptions } from "./runtime.js";
import { sequentialIds } from "./runtime-deps.js";
import { InMemoryRunStateStore } from "./state-store.js";
import { createScriptedProvider, type ScriptedStep } from "./testing.js";
import type { ToolInvoker } from "./tool.js";

const model = { providerId: "scripted", modelId: "test-model" };

function setup(steps: ScriptedStep[], options: Partial<RuntimeOptions> = {}, agent: Partial<AgentConfig<unknown>> = {}) {
  const provider = createScriptedProvider(steps, {
    capabilities: { pricing: { currency: "USD", inputPerMillionTokens: 1_000, outputPerMillionTokens: 2_000 } },
  });
  const sink = new InMemoryEventSink();
  const store = new InMemoryRunStateStore();
  const runtime = createRuntime({ providers: [provider], events: sink, stateStore: store, ids: sequentialIds(), retry: { initialDelayMs: 1 }, ...options });
  const a = defineAgent({ name: "test-agent", model, instructions: "Be brief.", runtime, ...agent });
  return { provider, sink, store, runtime, agent: a };
}

const echoInvoker: ToolInvoker = {
  async invoke(inv) {
    return { status: "success", output: { echoed: JSON.parse(String(inv.rawArguments)) }, attempts: 1, durationMs: 0, cached: false };
  },
};
const echoTool = { name: "echo", description: "Echo input", parameters: { type: "object" } };

describe("runtime configuration", () => {
  test("fails fast without providers or with duplicates", () => {
    expect(() => createRuntime({ providers: [] })).toThrow(ConfigurationError);
    const p = createScriptedProvider([]);
    expect(() => createRuntime({ providers: [p, p] })).toThrow(/duplicate/);
  });

  test("rejects an unknown provider id", async () => {
    const { runtime } = setup([]);
    const agent = defineAgent({ name: "x", model: { providerId: "nope", modelId: "m" } });
    await expect(runtime.run(agent, { input: "hi" })).rejects.toThrow(/No LLM provider/);
  });

  test("rejects tools without a tool invoker", async () => {
    const { agent } = setup([], {}, { tools: [echoTool] });
    await expect(agent.run({ input: "hi" })).rejects.toThrow(/no tool invoker/);
  });

  test("rejects tools on a model without tool calling", async () => {
    const provider = createScriptedProvider([], { capabilities: { toolCalling: false } });
    const runtime = createRuntime({ providers: [provider], tools: echoInvoker });
    const agent = defineAgent({ name: "x", model, tools: [echoTool], runtime });
    await expect(agent.run({ input: "hi" })).rejects.toThrow(/does not support tool calling/);
  });

  test("rejects duplicate caller-supplied run ids", async () => {
    const { agent } = setup([{ text: "a" }, { text: "b" }]);
    await agent.run({ input: "hi", runId: "fixed" });
    await expect(agent.run({ input: "hi", runId: "fixed" })).rejects.toThrow(ValidationError);
  });
});

describe("run lifecycle", () => {
  test("completes and emits the lifecycle in order", async () => {
    const { agent, sink, provider } = setup([{ text: "Hello!" }]);
    const result = await agent.run({ input: "Hi", user: { userId: "u1", tenantId: "t1" } });

    expect(result).toMatchObject({ status: "COMPLETED", output: "Hello!", agentId: "test-agent", runId: "run_1" });
    expect(result.events.map((e) => e.type)).toEqual([
      "AGENT_STARTED",
      "STEP_STARTED",
      "LLM_CALL_STARTED",
      "LLM_CALL_COMPLETED",
      "STEP_COMPLETED",
      "AGENT_COMPLETED",
    ]);
    expect(result.events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(sink.events).toEqual(result.events);
    expect(sink.ofType("AGENT_STARTED")[0]?.payload).toEqual({ userId: "u1", tenantId: "t1" });
    expect(provider.requests[0]?.messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "Hi" },
    ]);
  });

  test("tracks tokens and estimated cost", async () => {
    const { agent } = setup([{ text: "ok", usage: { inputTokens: 1000, outputTokens: 500 } }]);
    const result = await agent.run({ input: "x" });
    expect(result.usage).toMatchObject({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500, llmCalls: 1 });
    expect(result.usage.estimatedCostUsd).toBeCloseTo(1 + 1);
  });

  test("serializes non-string input as JSON", async () => {
    const { agent, provider } = setup([{ text: "ok" }]);
    await agent.run({ input: { topic: "x" } });
    expect(provider.requests[0]?.messages.at(-1)).toEqual({ role: "user", content: '{"topic":"x"}' });
  });

  test("persists state that can be inspected", async () => {
    const { agent, runtime } = setup([{ text: "done" }]);
    const result = await agent.run({ input: "x", metadata: { ticket: "T-1" } });
    const state = await runtime.getState(result.runId);
    expect(state).toMatchObject({ status: "COMPLETED", output: "done", metadata: { ticket: "T-1" }, eventSequence: 6 });
  });

  test("a failing event sink never breaks the run", async () => {
    const onSinkError = vi.fn();
    const { agent } = setup([{ text: "ok" }], { events: { emit: () => { throw new Error("sink down"); } }, onSinkError });
    const result = await agent.run({ input: "x" });
    expect(result.status).toBe("COMPLETED");
    expect(onSinkError).toHaveBeenCalled();
  });

  test("passes the transcript through the context manager", async () => {
    const context: ContextManager = {
      assemble: vi.fn(async (req: ContextAssemblyRequest) => ({ messages: req.messages.filter((m) => m.role !== "system") })),
    };
    const { agent, provider } = setup([{ text: "ok" }], { context });
    await agent.run({ input: "x" });
    expect(context.assemble).toHaveBeenCalledOnce();
    expect(provider.requests[0]?.messages).toEqual([{ role: "user", content: "x" }]);
  });
});

describe("provider errors", () => {
  test("normalizes a raw provider error to LLM_ERROR and fails the run", async () => {
    const { agent } = setup([{ error: new Error("boom") }]);
    const result = await agent.run({ input: "x" });
    expect(result.status).toBe("FAILED");
    expect(result.error).toMatchObject({ code: "LLM_ERROR", message: "boom", runId: result.runId });
    expect(result.events.at(-1)?.type).toBe("AGENT_FAILED");
    expect(result.steps[0]).toMatchObject({ status: "FAILED", kind: "llm_call" });
  });

  test("retries retryable provider errors", async () => {
    const { agent } = setup([{ error: new LLMError("503", { retryable: true }) }, { text: "recovered" }]);
    const result = await agent.run({ input: "x" });
    expect(result).toMatchObject({ status: "COMPLETED", output: "recovered" });
    const failed = result.events.filter((e) => e.type === "LLM_CALL_FAILED");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload).toMatchObject({ willRetry: true, attempt: 1 });
    expect(result.steps[0]?.attempts).toBe(2);
  });

  test("stops retrying at maxLLMRetries", async () => {
    const err = () => ({ error: new LLMError("503", { retryable: true }) });
    const { agent } = setup([err(), err(), err()], {}, { limits: { maxLLMRetries: 1 } });
    const result = await agent.run({ input: "x" });
    expect(result.status).toBe("FAILED");
    expect(result.events.filter((e) => e.type === "LLM_CALL_STARTED")).toHaveLength(2);
  });

  test("propagates structured framework errors unchanged", async () => {
    const { agent } = setup([{ error: new ValidationError("bad request", { metadata: { field: "x" } }) }]);
    const result = await agent.run({ input: "x" });
    expect(result.error).toMatchObject({ code: "VALIDATION_ERROR", metadata: { field: "x" } });
  });

  test("rejects malformed provider responses", async () => {
    const { agent } = setup([() => ({ nonsense: true }) as never]);
    const result = await agent.run({ input: "x" });
    expect(result.error).toMatchObject({ code: "LLM_ERROR", message: "Provider returned a malformed response" });
  });
});

describe("limits, cancellation and timeouts", () => {
  const loopingToolCall = (id: string): ScriptedStep => ({ toolCalls: [{ id, name: "echo", arguments: {} }] });

  test("maxSteps stops an infinite tool loop", async () => {
    const { agent } = setup([loopingToolCall("a"), loopingToolCall("b"), loopingToolCall("c")], { tools: echoInvoker }, { tools: [echoTool], limits: { maxSteps: 2 } });
    const result = await agent.run({ input: "x" });
    expect(result.status).toBe("FAILED");
    expect(result.error).toMatchObject({ code: "LIMIT_EXCEEDED", metadata: { limitType: "steps" } });
    expect(result.events.some((e) => e.type === "LIMIT_EXCEEDED")).toBe(true);
  });

  test("maxToolCalls is enforced", async () => {
    const many: ScriptedStep = { toolCalls: [1, 2, 3].map((i) => ({ id: `c${i}`, name: "echo", arguments: {} })) };
    const invoke = vi.fn(echoInvoker.invoke);
    const { agent } = setup([many], { tools: { invoke } }, { tools: [echoTool], limits: { maxToolCalls: 2 } });
    const result = await agent.run({ input: "x" });
    expect(result.error).toMatchObject({ code: "LIMIT_EXCEEDED", metadata: { limitType: "toolCalls" } });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  test("maxTokens budget", async () => {
    const { agent } = setup([{ text: "x", usage: { inputTokens: 900, outputTokens: 200 } }], {}, { limits: { maxTokens: 1000 } });
    const result = await agent.run({ input: "x" });
    expect(result.error).toMatchObject({ code: "LIMIT_EXCEEDED", metadata: { limitType: "tokens", current: 1100 } });
  });

  test("maxCost budget, run-level override wins", async () => {
    const { agent } = setup([{ text: "x", usage: { inputTokens: 1000, outputTokens: 0 } }], {}, { limits: { maxCost: 10 } });
    const result = await agent.run({ input: "x", limits: { maxCost: 0.5 } });
    expect(result.error).toMatchObject({ code: "LIMIT_EXCEEDED", metadata: { limitType: "cost" } });
  });

  test("an already-aborted signal cancels before any model call", async () => {
    const { agent, provider } = setup([{ text: "never" }]);
    const result = await agent.run({ input: "x", signal: AbortSignal.abort() });
    expect(result.status).toBe("CANCELLED");
    expect(provider.requests).toHaveLength(0);
    expect(result.events.at(-1)?.type).toBe("AGENT_CANCELLED");
  });

  test("cancellation during a model call stops the run promptly", async () => {
    const controller = new AbortController();
    const { agent } = setup([() => new Promise(() => {})]);
    const pending = agent.run({ input: "x", signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    const result = await pending;
    expect(result.status).toBe("CANCELLED");
    expect(result.steps[0]?.status).toBe("FAILED");
  });

  test("run timeout", async () => {
    const { agent } = setup([() => new Promise(() => {})], {}, { limits: { timeoutMs: 20 } });
    const result = await agent.run({ input: "x" });
    expect(result.status).toBe("TIMED_OUT");
    expect(result.error?.code).toBe("RUN_TIMEOUT");
  });
});

describe("tool calls through the invoker port", () => {
  test("model → tool → model → answer", async () => {
    const { agent, provider } = setup(
      [{ toolCalls: [{ id: "c1", name: "echo", arguments: { q: 1 } }] }, { text: "final" }],
      { tools: echoInvoker },
      { tools: [echoTool] },
    );
    const result = await agent.run({ input: "x" });
    expect(result).toMatchObject({ status: "COMPLETED", output: "final" });
    expect(result.usage.toolCalls).toBe(1);
    expect(provider.requests[0]?.tools).toEqual([echoTool]);
    expect(provider.requests[1]?.messages.at(-1)).toEqual({ role: "tool", toolCallId: "c1", toolName: "echo", content: '{"echoed":{"q":1}}' });
    expect(result.steps.map((s) => [s.kind, s.status])).toEqual([
      ["llm_call", "COMPLETED"],
      ["tool_call", "COMPLETED"],
      ["llm_call", "COMPLETED"],
    ]);
  });

  test("a tool the agent does not have is never invoked", async () => {
    const invoke = vi.fn(echoInvoker.invoke);
    const { agent, provider } = setup(
      [{ toolCalls: [{ id: "c1", name: "delete_everything", arguments: {} }] }, { text: "sorry" }],
      { tools: { invoke } },
      { tools: [echoTool] },
    );
    const result = await agent.run({ input: "x" });
    expect(invoke).not.toHaveBeenCalled();
    expect(result.status).toBe("COMPLETED");
    expect(provider.requests[1]?.messages.at(-1)).toMatchObject({ role: "tool", isError: true });
    expect(result.steps[1]).toMatchObject({ status: "FAILED", error: { code: "TOOL_NOT_FOUND" } });
  });
});

describe("structured output", () => {
  const Report = z.object({ summary: z.string(), confidence: z.number().min(0).max(1) });

  test("parses and validates JSON output (fenced or bare)", async () => {
    const { agent } = setup([{ text: '```json\n{"summary":"s","confidence":0.9}\n```' }], {}, { output: Report });
    const result = await agent.run({ input: "x" });
    expect(result).toMatchObject({ status: "COMPLETED", output: { summary: "s", confidence: 0.9 } });
  });

  test("fails on invalid JSON or schema mismatch", async () => {
    const bad = setup([{ text: "not json" }], {}, { output: Report, limits: { maxOutputCorrections: 0 } });
    await expect(bad.agent.run({ input: "x" })).resolves.toMatchObject({ status: "FAILED", error: { code: "OUTPUT_VALIDATION_ERROR" } });
    const mismatch = setup([{ text: '{"summary":"s","confidence":7}' }], {}, { output: Report, limits: { maxOutputCorrections: 0 } });
    const result = await mismatch.agent.run({ input: "x" });
    expect(result.error?.code).toBe("OUTPUT_VALIDATION_ERROR");
    expect(result.output).toBeUndefined();
  });

  test("requests JSON when the model supports structured output", async () => {
    const { agent, provider } = setup([{ text: '{"summary":"s","confidence":1}' }], {}, { output: Report });
    await agent.run({ input: "x" });
    expect(provider.requests[0]?.responseFormat).toMatchObject({ type: "json", schema: { type: "object", required: ["summary", "confidence"] } });
  });
});

describe("InMemoryRunStateStore.claim", () => {
  test("is a compare-and-set on status", async () => {
    const store = new InMemoryRunStateStore();
    await store.save({ runId: "r1", status: "WAITING_FOR_APPROVAL" } as never);
    expect(await store.claim("r1", "WAITING_FOR_APPROVAL", "RUNNING")).toBe(true);
    expect(await store.claim("r1", "WAITING_FOR_APPROVAL", "RUNNING")).toBe(false);
    expect(await store.claim("missing", "WAITING_FOR_APPROVAL", "RUNNING")).toBe(false);
    expect((await store.load("r1"))?.status).toBe("RUNNING");
  });
});
