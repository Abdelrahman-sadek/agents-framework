import { InMemoryEventSink, ToolError, createRuntime, defineAgent, sequentialIds, type RuntimeOptions } from "@agent-framework/core";
import { createScriptedProvider, type ScriptedStep } from "@agent-framework/core/testing";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { InMemoryAuditLog } from "./stores.js";
import { defineTool, type AnyTool } from "./tool.js";
import { ToolRuntime } from "./tool-runtime.js";

function setup(steps: ScriptedStep[], tools: AnyTool[], extra: { permissions?: string[]; runtime?: Partial<RuntimeOptions> } = {}) {
  const provider = createScriptedProvider(steps);
  const audit = new InMemoryAuditLog();
  const sink = new InMemoryEventSink();
  const runtime = createRuntime({
    providers: [provider],
    tools: new ToolRuntime({ audit }),
    events: sink,
    ids: sequentialIds(),
    ...extra.runtime,
  });
  const agent = defineAgent({
    name: "research-agent",
    model: { providerId: provider.id, modelId: "m" },
    instructions: "Research the requested topic.",
    tools,
    permissions: extra.permissions ?? [],
    runtime,
  });
  return { provider, audit, sink, runtime, agent };
}

const SearchInput = z.object({ query: z.string() });
const SearchOutput = z.object({ results: z.array(z.string()) });
const searchTool = defineTool({
  name: "search",
  description: "Search the knowledge source",
  input: SearchInput,
  output: SearchOutput,
  execute: async ({ query }) => ({ results: [`doc about ${query}`] }),
});

describe("agent → LLM → tool", () => {
  test("successful tool execution feeds the result back to the model", async () => {
    const { agent, provider, audit } = setup(
      [{ toolCalls: [{ id: "c1", name: "search", arguments: { query: "agents" } }] }, { text: "Agents are programs." }],
      [searchTool],
    );
    const result = await agent.run({ input: "Research agents" });

    expect(result).toMatchObject({ status: "COMPLETED", output: "Agents are programs." });
    expect(provider.requests[0]?.tools?.[0]).toMatchObject({ name: "search", description: "Search the knowledge source" });
    expect(provider.requests[1]?.messages.at(-1)).toEqual({
      role: "tool",
      toolCallId: "c1",
      toolName: "search",
      content: JSON.stringify({ results: ["doc about agents"] }),
    });
    expect(result.events.map((e) => e.type)).toEqual([
      "AGENT_STARTED",
      "STEP_STARTED",
      "LLM_CALL_STARTED",
      "LLM_CALL_COMPLETED",
      "STEP_COMPLETED",
      "STEP_STARTED",
      "TOOL_REQUESTED",
      "TOOL_AUTHORIZATION_STARTED",
      "TOOL_AUTHORIZATION_COMPLETED",
      "TOOL_EXECUTION_STARTED",
      "TOOL_EXECUTION_COMPLETED",
      "STEP_COMPLETED",
      "STEP_STARTED",
      "LLM_CALL_STARTED",
      "LLM_CALL_COMPLETED",
      "STEP_COMPLETED",
      "AGENT_COMPLETED",
    ]);
    const toolEvents = result.events.filter((e) => e.type.startsWith("TOOL_"));
    expect(new Set(toolEvents.map((e) => e.correlation?.stepId)).size).toBe(1);
    expect(toolEvents.every((e) => e.correlation?.llmCallId === "llm_1")).toBe(true);
    expect(audit.entries[0]).toMatchObject({ runId: result.runId, agentId: "research-agent", outcome: "success" });
  });

  test("invalid arguments are reported to the model and never executed", async () => {
    const execute = vi.fn(async () => ({ results: [] }));
    const tool = defineTool({ name: "search", description: "d", input: SearchInput, execute });
    const { agent, provider } = setup(
      [{ toolCalls: [{ id: "c1", name: "search", arguments: { q: "typo" } }] }, { toolCalls: [{ id: "c2", name: "search", arguments: { query: "fixed" } }] }, { text: "done" }],
      [tool],
    );
    const result = await agent.run({ input: "x" });
    expect(result.status).toBe("COMPLETED");
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith({ query: "fixed" }, expect.anything());
    const feedback = provider.requests[1]?.messages.at(-1);
    expect(feedback).toMatchObject({ role: "tool", isError: true });
    expect(feedback?.content).toContain("VALIDATION_ERROR");
  });

  test("authorization denial", async () => {
    const execute = vi.fn();
    const tool = defineTool({ name: "delete_records", description: "d", input: z.object({}), permissions: ["records.delete"], execute });
    const { agent, audit } = setup([{ toolCalls: [{ id: "c1", name: "delete_records", arguments: {} }] }, { text: "I cannot do that." }], [tool], { permissions: ["records.read"] });
    const result = await agent.run({ input: "delete all", user: { userId: "u", permissions: ["records.delete"] } });
    expect(execute).not.toHaveBeenCalled();
    expect(result.status).toBe("COMPLETED");
    expect(result.steps[1]).toMatchObject({ kind: "tool_call", status: "FAILED", error: { code: "TOOL_AUTHORIZATION_ERROR" } });
    expect(audit.entries[0]).toMatchObject({ outcome: "denied", userId: "u" });
  });

  test("tool timeout is surfaced to the model", async () => {
    const tool = defineTool({ name: "slow", description: "d", input: z.object({}), timeoutMs: 10, execute: () => new Promise<never>(() => {}) });
    const { agent, provider } = setup([{ toolCalls: [{ id: "c1", name: "slow", arguments: {} }] }, { text: "It timed out." }], [tool]);
    const result = await agent.run({ input: "x" });
    expect(result.status).toBe("COMPLETED");
    expect(provider.requests[1]?.messages.at(-1)?.content).toContain("TOOL_TIMEOUT");
    expect(result.events.some((e) => e.type === "TOOL_EXECUTION_TIMED_OUT")).toBe(true);
  });

  test("retryable failure is retried transparently", async () => {
    let calls = 0;
    const tool = defineTool({
      name: "flaky",
      description: "d",
      input: z.object({}),
      retry: { maxAttempts: 2, initialDelayMs: 1 },
      execute: async () => {
        calls += 1;
        if (calls === 1) throw new ToolError("503", { retryable: true });
        return "ok";
      },
    });
    const { agent } = setup([{ toolCalls: [{ id: "c1", name: "flaky", arguments: {} }] }, { text: "done" }], [tool]);
    const result = await agent.run({ input: "x" });
    expect(result.steps[1]).toMatchObject({ status: "COMPLETED", attempts: 2 });
  });

  test("non-retryable failure is propagated to the agent as a failed step", async () => {
    const tool = defineTool({ name: "broken", description: "d", input: z.object({}), retry: { maxAttempts: 3 }, execute: async () => { throw new ToolError("invalid account", { retryable: false }); } });
    const { agent, provider } = setup([{ toolCalls: [{ id: "c1", name: "broken", arguments: {} }] }, { text: "The account is invalid." }], [tool]);
    const result = await agent.run({ input: "x" });
    expect(result.steps[1]).toMatchObject({ status: "FAILED", attempts: 1, error: { code: "TOOL_ERROR", message: "invalid account" } });
    expect(provider.requests[1]?.messages.at(-1)).toMatchObject({ isError: true, content: expect.stringContaining("invalid account") });
    expect(result.output).toBe("The account is invalid.");
  });

  test("multiple tools in one model turn", async () => {
    const weather = defineTool({ name: "weather", description: "d", input: z.object({ city: z.string() }), execute: async ({ city }) => `${city}: 18C` });
    const { agent, provider } = setup(
      [
        {
          toolCalls: [
            { id: "c1", name: "search", arguments: { query: "cairo" } },
            { id: "c2", name: "weather", arguments: { city: "Cairo" } },
          ],
        },
        { text: "summary" },
      ],
      [searchTool, weather],
    );
    const result = await agent.run({ input: "x" });
    expect(result.usage.toolCalls).toBe(2);
    const toolMessages = provider.requests[1]?.messages.filter((m) => m.role === "tool");
    expect(toolMessages?.map((m) => (m.role === "tool" ? m.toolCallId : ""))).toEqual(["c1", "c2"]);
    expect(toolMessages?.[1]?.content).toBe("Cairo: 18C");
  });
});

describe("human approval flow", () => {
  const execute = vi.fn(async ({ amount }: { amount: number }) => ({ refunded: amount }));
  const refund = defineTool({
    name: "refund",
    description: "Refund a customer",
    input: z.object({ amount: z.number() }),
    approval: { required: true, expiresInMs: 60_000 },
    execute,
  });

  test("pauses, persists, and resumes after approval", async () => {
    execute.mockClear();
    const { agent, runtime, sink } = setup([{ toolCalls: [{ id: "c1", name: "refund", arguments: { amount: 250 } }] }, { text: "Refunded 250." }], [refund]);
    const paused = await agent.run({ input: "refund order 7" });

    expect(paused.status).toBe("WAITING_FOR_APPROVAL");
    expect(paused.pendingApprovals).toHaveLength(1);
    expect(paused.events.at(-1)?.type).toBe("AGENT_WAITING_FOR_APPROVAL");
    expect(execute).not.toHaveBeenCalled();
    expect((await runtime.getState(paused.runId))?.status).toBe("WAITING_FOR_APPROVAL");

    const approvalId = paused.pendingApprovals[0]!.approvalId;
    const resumed = await agent.resume({ runId: paused.runId, approvals: [{ approvalId, decision: "approved", decidedBy: "ops-lead" }] });

    expect(resumed).toMatchObject({ status: "COMPLETED", output: "Refunded 250.", pendingApprovals: [] });
    expect(execute).toHaveBeenCalledWith({ amount: 250 }, expect.anything());
    expect(resumed.events[0]?.type).toBe("AGENT_RESUMED");
    expect(resumed.events[0]?.sequence).toBe(paused.events.at(-1)!.sequence + 1);
    expect(resumed.steps.find((s) => s.kind === "tool_call")?.status).toBe("COMPLETED");
    expect(sink.ofType("TOOL_APPROVAL_GRANTED")[0]?.payload.decidedBy).toBe("ops-lead");
  });

  test("rejection is reported to the model, which can respond", async () => {
    execute.mockClear();
    const { agent, provider } = setup([{ toolCalls: [{ id: "c1", name: "refund", arguments: { amount: 250 } }] }, { text: "The refund was declined." }], [refund]);
    const paused = await agent.run({ input: "refund" });
    const resumed = await agent.resume({ runId: paused.runId, approvals: [{ approvalId: paused.pendingApprovals[0]!.approvalId, decision: "rejected", reason: "policy" }] });
    expect(execute).not.toHaveBeenCalled();
    expect(resumed).toMatchObject({ status: "COMPLETED", output: "The refund was declined." });
    expect(resumed.steps[1]?.status).toBe("REJECTED");
    expect(provider.requests[1]?.messages.at(-1)?.content).toContain("APPROVAL_REJECTED");
  });

  test("expired approvals end the run without executing", async () => {
    execute.mockClear();
    let now = Date.parse("2026-01-01T00:00:00Z");
    const clock = { now: () => new Date(now) };
    const provider = createScriptedProvider([{ toolCalls: [{ id: "c1", name: "refund", arguments: { amount: 1 } }] }]);
    const runtime = createRuntime({ providers: [provider], tools: new ToolRuntime({ clock }), clock });
    const agent = defineAgent({ name: "a", model: { providerId: provider.id, modelId: "m" }, tools: [refund], runtime });
    const paused = await agent.run({ input: "x" });
    now += 61_000;
    const resumed = await agent.resume({ runId: paused.runId, approvals: [{ approvalId: paused.pendingApprovals[0]!.approvalId, decision: "approved" }] });
    expect(resumed.status).toBe("APPROVAL_EXPIRED");
    expect(resumed.error?.code).toBe("APPROVAL_EXPIRED");
    expect(execute).not.toHaveBeenCalled();
  });

  test("resume validates run state and approval ids", async () => {
    const { agent } = setup([{ toolCalls: [{ id: "c1", name: "refund", arguments: { amount: 1 } }] }, { text: "ok" }], [refund]);
    await expect(agent.resume({ runId: "missing", approvals: [] })).rejects.toThrow(/not found/);
    const paused = await agent.run({ input: "x" });
    await expect(agent.resume({ runId: paused.runId, approvals: [{ approvalId: "forged", decision: "approved" }] })).rejects.toThrow(/not pending/);
    await agent.resume({ runId: paused.runId, approvals: [{ approvalId: paused.pendingApprovals[0]!.approvalId, decision: "approved" }] });
    await expect(agent.resume({ runId: paused.runId, approvals: [] })).rejects.toThrow(/COMPLETED/);
  });

  test("resume without a decision keeps waiting", async () => {
    const { agent } = setup([{ toolCalls: [{ id: "c1", name: "refund", arguments: { amount: 1 } }] }], [refund]);
    const paused = await agent.run({ input: "x" });
    const again = await agent.resume({ runId: paused.runId, approvals: [] });
    expect(again.status).toBe("WAITING_FOR_APPROVAL");
    expect(again.pendingApprovals).toHaveLength(1);
  });
});

describe("approval: modify and escalate", () => {
  const pay = vi.fn(async ({ amount }: { amount: number }) => ({ paid: amount }));
  const payTool = defineTool({ name: "pay", description: "Pay", input: z.object({ amount: z.number().max(1000) }), approval: { required: true }, execute: pay });

  test("a reviewer can approve with modified (re-validated) arguments", async () => {
    pay.mockClear();
    const { agent, audit, sink } = setup([{ toolCalls: [{ id: "c1", name: "pay", arguments: { amount: 900 } }] }, { text: "Paid." }], [payTool]);
    const paused = await agent.run({ input: "pay 900" });
    const approvalId = paused.pendingApprovals[0]!.approvalId;
    const done = await agent.resume({ runId: paused.runId, approvals: [{ approvalId, decision: "modified", modifiedArguments: { amount: 500 }, decidedBy: "cfo" }] });
    expect(done.status).toBe("COMPLETED");
    expect(pay).toHaveBeenCalledWith({ amount: 500 }, expect.anything());
    expect(sink.ofType("TOOL_APPROVAL_GRANTED")[0]?.payload).toMatchObject({ modified: true, decidedBy: "cfo" });
    expect(audit.entries.at(-1)?.approval).toMatchObject({ decision: "modified" });
  });

  test("modified arguments that fail validation never execute", async () => {
    pay.mockClear();
    const { agent } = setup([{ toolCalls: [{ id: "c1", name: "pay", arguments: { amount: 900 } }] }, { text: "Could not pay." }], [payTool]);
    const paused = await agent.run({ input: "pay" });
    const done = await agent.resume({ runId: paused.runId, approvals: [{ approvalId: paused.pendingApprovals[0]!.approvalId, decision: "modified", modifiedArguments: { amount: 99_999 } }] });
    expect(pay).not.toHaveBeenCalled();
    expect(done.steps.find((s) => s.kind === "tool_call")?.error?.code).toBe("VALIDATION_ERROR");
  });

  test("escalation keeps the approval pending and records the new reviewer", async () => {
    pay.mockClear();
    const { agent, sink } = setup([{ toolCalls: [{ id: "c1", name: "pay", arguments: { amount: 900 } }] }, { text: "Paid." }], [payTool]);
    const paused = await agent.run({ input: "pay" });
    const approvalId = paused.pendingApprovals[0]!.approvalId;
    const escalated = await agent.resume({ runId: paused.runId, approvals: [{ approvalId, decision: "escalated", escalateTo: "finance-director", decidedBy: "team-lead" }] });
    expect(escalated.status).toBe("WAITING_FOR_APPROVAL");
    expect(escalated.pendingApprovals[0]?.escalatedTo).toEqual(["finance-director"]);
    expect(sink.ofType("TOOL_APPROVAL_ESCALATED")[0]?.payload).toMatchObject({ escalateTo: "finance-director" });
    expect(pay).not.toHaveBeenCalled();
    await expect(agent.resume({ runId: paused.runId, approvals: [{ approvalId, decision: "escalated" }] })).rejects.toThrow(/escalateTo/);
    const done = await agent.resume({ runId: paused.runId, approvals: [{ approvalId, decision: "approved", decidedBy: "finance-director" }] });
    expect(done.status).toBe("COMPLETED");
    expect(pay).toHaveBeenCalledOnce();
  });
});
