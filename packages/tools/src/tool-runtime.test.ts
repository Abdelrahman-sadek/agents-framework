import { CancellationError, ToolError } from "@agent-farmework/core";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { allOf, permissionPolicy, policy } from "./policy.js";
import { InMemoryAuditLog } from "./stores.js";
import { agentIdentity, invocation, user } from "./test-helpers.js";
import { defineTool } from "./tool.js";
import { ToolRuntime, hashArguments } from "./tool-runtime.js";

const search = defineTool({
  name: "search",
  description: "Search",
  input: z.object({ query: z.string().min(1) }),
  output: z.object({ results: z.array(z.string()) }),
  execute: async ({ query }) => ({ results: [`hit:${query}`] }),
});

function runtime(options: ConstructorParameters<typeof ToolRuntime>[0] = {}) {
  const audit = new InMemoryAuditLog();
  return { tools: new ToolRuntime({ audit, ...options }), audit };
}

describe("ToolRuntime: happy path", () => {
  test("parses JSON arguments, executes, validates output and emits the lifecycle", async () => {
    const { tools, audit } = runtime();
    const { inv, types, sink } = invocation(search, '{"query":"agents"}');
    const result = await tools.invoke(inv);

    expect(result).toMatchObject({ status: "success", output: { results: ["hit:agents"] }, attempts: 1, cached: false });
    expect(types()).toEqual([
      "TOOL_AUTHORIZATION_STARTED",
      "TOOL_AUTHORIZATION_COMPLETED",
      "TOOL_EXECUTION_STARTED",
      "TOOL_EXECUTION_COMPLETED",
    ]);
    expect(sink.events.every((e) => e.correlation?.toolCallId === "call-1")).toBe(true);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      outcome: "success",
      toolName: "search",
      input: { query: "agents" },
      authorization: { allowed: true, policy: "permission" },
    });
  });

  test("execute() runs the same pipeline for application code", async () => {
    const { tools } = runtime();
    const result = await tools.execute(search, { query: "x" }, { agent: agentIdentity() });
    expect(result.output?.results).toEqual(["hit:x"]);
  });

  test("passes context to the tool", async () => {
    const execute = vi.fn(async () => "ok");
    const tool = defineTool({ name: "ctx", description: "d", input: z.object({}), execute });
    const { tools } = runtime();
    const u = user();
    await tools.invoke(invocation(tool, "{}", { identity: { agent: agentIdentity(), user: u }, stepId: "s1" }).inv);
    expect(execute).toHaveBeenCalledWith({}, expect.objectContaining({ runId: "run-1", toolCallId: "call-1", stepId: "s1", user: u, attempt: 1 }));
  });

  test("empty argument string is treated as an empty object", async () => {
    const tool = defineTool({ name: "noargs", description: "d", input: z.object({}), execute: () => 1 });
    const { tools } = runtime();
    await expect(tools.invoke(invocation(tool, "").inv)).resolves.toMatchObject({ status: "success", output: 1 });
  });
});

describe("ToolRuntime: validation", () => {
  test("malformed JSON never executes", async () => {
    const execute = vi.fn();
    const tool = defineTool({ name: "t", description: "d", input: z.object({ a: z.string() }), execute });
    const { tools, audit } = runtime();
    const result = await tools.invoke(invocation(tool, "{not json").inv);
    expect(result).toMatchObject({ status: "error", error: { code: "VALIDATION_ERROR" }, attempts: 0 });
    expect(execute).not.toHaveBeenCalled();
    expect(audit.entries[0]).not.toHaveProperty("input");
  });

  test("schema-invalid arguments never execute and the message helps the model self-correct", async () => {
    const { tools } = runtime();
    const { inv, types } = invocation(search, { query: 42 });
    const result = await tools.invoke(inv);
    expect(result.status).toBe("error");
    expect(result.error?.message).toMatch(/Invalid arguments for tool 'search'.*query/s);
    expect(types()).toEqual([]);
  });

  test("invalid output is rejected, not returned", async () => {
    const tool = defineTool({
      name: "liar",
      description: "d",
      input: z.object({}),
      output: z.object({ n: z.number() }),
      execute: async () => ({ n: "nope" }) as never,
    });
    const { tools } = runtime();
    const result = await tools.invoke(invocation(tool, "{}").inv);
    expect(result).toMatchObject({ status: "error", error: { code: "TOOL_OUTPUT_INVALID", retryable: false } });
    expect(result.output).toBeUndefined();
  });
});

describe("ToolRuntime: authorization", () => {
  const guarded = defineTool({ name: "read_db", description: "d", input: z.object({}), permissions: ["database.read"], execute: vi.fn(async () => "rows") });

  test("allows when agent and user both hold the permission (wildcards supported)", async () => {
    const { tools } = runtime();
    const identity = { agent: agentIdentity(["database.*"]), user: user(["database.read"]) };
    await expect(tools.invoke(invocation(guarded, "{}", { identity }).inv)).resolves.toMatchObject({ status: "success" });
  });

  test("denies when the agent lacks the permission", async () => {
    const { tools, audit } = runtime();
    const { inv, sink } = invocation(guarded, "{}", { identity: { agent: agentIdentity([]), user: user(["database.read"]) } });
    const result = await tools.invoke(inv);
    expect(result).toMatchObject({ status: "denied", error: { code: "TOOL_AUTHORIZATION_ERROR", message: "Tool call was not authorized" } });
    expect(sink.ofType("TOOL_AUTHORIZATION_COMPLETED")[0]?.payload).toMatchObject({ allowed: false, reason: expect.stringContaining("Agent") });
    expect(audit.entries[0]).toMatchObject({ outcome: "denied", authorization: { allowed: false } });
  });

  test("custom policies compose with allOf and the first denial wins", async () => {
    const tenantOnly = policy("tenant-a-only", ({ user: u }) => ({ allowed: u?.tenantId === "tenant-a", reason: "tenant check" }));
    const { tools } = runtime({ policy: allOf(permissionPolicy(), tenantOnly) });
    const ok = await tools.invoke(invocation(search, '{"query":"x"}', { identity: { agent: agentIdentity(), user: user([], "tenant-a") } }).inv);
    const denied = await tools.invoke(invocation(search, '{"query":"x"}', { identity: { agent: agentIdentity(), user: user([], "tenant-b") } }).inv);
    expect(ok.status).toBe("success");
    expect(denied.status).toBe("denied");
  });

  test("requireUser denies system runs", async () => {
    const { tools } = runtime({ policy: permissionPolicy({ requireUser: true }) });
    await expect(tools.invoke(invocation(search, '{"query":"x"}').inv)).resolves.toMatchObject({ status: "denied" });
  });
});

describe("ToolRuntime: reliability", () => {
  test("enforces the timeout even when the tool ignores its signal", async () => {
    const tool = defineTool({ name: "slow", description: "d", input: z.object({}), timeoutMs: 20, execute: () => new Promise<never>(() => {}) });
    const { tools } = runtime();
    const { inv, types } = invocation(tool, "{}");
    const result = await tools.invoke(inv);
    expect(result).toMatchObject({ status: "error", error: { code: "TOOL_TIMEOUT" }, attempts: 1 });
    expect(types()).toContain("TOOL_EXECUTION_TIMED_OUT");
  });

  test("aborts the tool's signal on timeout", async () => {
    let seen: AbortSignal | undefined;
    const tool = defineTool({
      name: "cooperative",
      description: "d",
      input: z.object({}),
      timeoutMs: 10,
      execute: (_i, ctx) => {
        seen = ctx.signal;
        return new Promise<never>(() => {});
      },
    });
    await runtime().tools.invoke(invocation(tool, "{}").inv);
    expect(seen?.aborted).toBe(true);
  });

  test("does not retry timeouts unless retryOnTimeout is set", async () => {
    const execute = vi.fn(() => new Promise<never>(() => {}));
    const tool = defineTool({ name: "t", description: "d", input: z.object({}), timeoutMs: 5, retry: { maxAttempts: 3, initialDelayMs: 1 }, execute });
    await runtime().tools.invoke(invocation(tool, "{}").inv);
    expect(execute).toHaveBeenCalledTimes(1);
    const retrying = defineTool({ name: "t2", description: "d", input: z.object({}), timeoutMs: 5, retry: { maxAttempts: 3, initialDelayMs: 1, retryOnTimeout: true }, execute });
    await runtime().tools.invoke(invocation(retrying, "{}").inv);
    expect(execute).toHaveBeenCalledTimes(4);
  });

  test("retries retryable failures with backoff, then succeeds", async () => {
    let calls = 0;
    const tool = defineTool({
      name: "flaky",
      description: "d",
      input: z.object({}),
      retry: { maxAttempts: 3, backoff: "exponential", initialDelayMs: 1 },
      execute: async () => {
        calls += 1;
        if (calls < 3) throw new ToolError("upstream 503", { retryable: true });
        return "ok";
      },
    });
    const { inv, sink } = invocation(tool, "{}");
    const result = await runtime().tools.invoke(inv);
    expect(result).toMatchObject({ status: "success", attempts: 3 });
    expect(sink.ofType("TOOL_EXECUTION_FAILED").map((e) => e.payload.willRetry)).toEqual([true, true]);
  });

  test("never retries non-retryable failures", async () => {
    const execute = vi.fn(async () => {
      throw new ToolError("bad request", { retryable: false });
    });
    const tool = defineTool({ name: "t", description: "d", input: z.object({}), retry: { maxAttempts: 5, initialDelayMs: 1 }, execute });
    const result = await runtime().tools.invoke(invocation(tool, "{}").inv);
    expect(result).toMatchObject({ status: "error", attempts: 1, error: { code: "TOOL_ERROR", message: "bad request" } });
    expect(execute).toHaveBeenCalledOnce();
  });

  test("raw exceptions are treated as non-retryable and their message stays out of the result", async () => {
    const tool = defineTool({
      name: "leaky",
      description: "d",
      input: z.object({}),
      retry: { maxAttempts: 3 },
      execute: async () => {
        throw new Error("password=hunter2 at db.internal:5432");
      },
    });
    const { tools, audit } = runtime();
    const result = await tools.invoke(invocation(tool, "{}").inv);
    expect(result).toMatchObject({ status: "error", attempts: 1, error: { code: "TOOL_ERROR", message: "Tool 'leaky' failed" } });
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(audit.entries[0]?.error?.metadata?.["detail"]).toContain("hunter2");
  });

  test("cancellation propagates and is not retried", async () => {
    const controller = new AbortController();
    const execute = vi.fn(() => new Promise<never>(() => {}));
    const tool = defineTool({ name: "t", description: "d", input: z.object({}), retry: { maxAttempts: 3, retryOnTimeout: true }, execute });
    const pending = runtime().tools.invoke(invocation(tool, "{}", { signal: controller.signal }).inv);
    controller.abort(new CancellationError("stop"));
    const result = await pending;
    expect(result).toMatchObject({ status: "error", error: { code: "CANCELLED" } });
    expect(execute).toHaveBeenCalledOnce();
  });

  test("rate limits per scope without executing", async () => {
    const execute = vi.fn(async () => "ok");
    const tool = defineTool({ name: "limited", description: "d", input: z.object({}), rateLimit: { maxCalls: 2, windowMs: 60_000, scope: "user" }, execute });
    const { tools } = runtime();
    const call = (userId: string) => tools.invoke(invocation(tool, "{}", { identity: { agent: agentIdentity(), user: user([], "t", userId) } }).inv);
    await call("alice");
    await call("alice");
    await expect(call("alice")).resolves.toMatchObject({ status: "error", error: { code: "RATE_LIMITED", retryable: true } });
    await expect(call("bob")).resolves.toMatchObject({ status: "success" });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  test("idempotency returns the stored result instead of executing twice", async () => {
    const execute = vi.fn(async ({ orderId }: { orderId: string }) => ({ refunded: orderId }));
    const tool = defineTool({
      name: "refund",
      description: "d",
      input: z.object({ orderId: z.string() }),
      idempotency: { key: (i) => i.orderId },
      execute,
    });
    const { tools } = runtime();
    const first = await tools.invoke(invocation(tool, { orderId: "o1" }).inv);
    const { inv, sink } = invocation(tool, { orderId: "o1" });
    const second = await tools.invoke(inv);
    expect(first).toMatchObject({ status: "success", cached: false });
    expect(second).toMatchObject({ status: "success", cached: true, output: { refunded: "o1" } });
    expect(sink.ofType("TOOL_EXECUTION_COMPLETED")[0]?.payload.cached).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  test("idempotency deduplicates concurrent duplicates", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const execute = vi.fn(async () => {
      await gate;
      return "done";
    });
    const tool = defineTool({ name: "once", description: "d", input: z.object({ k: z.string() }), idempotency: { key: (i) => i.k }, execute });
    const { tools } = runtime();
    const a = tools.invoke(invocation(tool, { k: "same" }).inv);
    const b = tools.invoke(invocation(tool, { k: "same" }).inv);
    release();
    const results = await Promise.all([a, b]);
    expect(execute).toHaveBeenCalledOnce();
    expect(results.map((r) => r.output)).toEqual(["done", "done"]);
  });

  test("concurrency limit serializes executions", async () => {
    let active = 0;
    let peak = 0;
    const tool = defineTool({
      name: "serial",
      description: "d",
      input: z.object({}),
      concurrency: 1,
      execute: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return "ok";
      },
    });
    const { tools } = runtime();
    await Promise.all([1, 2, 3].map(() => tools.invoke(invocation(tool, "{}").inv)));
    expect(peak).toBe(1);
  });
});

describe("ToolRuntime: approval", () => {
  const transfer = defineTool({
    name: "transfer",
    description: "Move money",
    input: z.object({ amount: z.number() }),
    approval: { required: (i) => i.amount > 100, expiresInMs: 60_000, reason: "Large transfer" },
    execute: vi.fn(async ({ amount }) => ({ transferred: amount })),
  });

  test("predicate decides when approval is needed", async () => {
    const { tools } = runtime();
    await expect(tools.invoke(invocation(transfer, { amount: 10 }).inv)).resolves.toMatchObject({ status: "success" });
    const { inv, types } = invocation(transfer, { amount: 500 });
    const pending = await tools.invoke(inv);
    expect(pending).toMatchObject({
      status: "approval_required",
      approval: { toolCallId: "call-1", toolName: "transfer", argumentsHash: hashArguments({ amount: 500 }), reason: "Large transfer" },
    });
    expect(pending.approval?.expiresAt).toBeDefined();
    expect(types()).toContain("TOOL_APPROVAL_REQUIRED");
    expect(types()).not.toContain("TOOL_EXECUTION_STARTED");
  });

  test("approved decision executes; rejected decision does not", async () => {
    const { tools, audit } = runtime();
    const request = (await tools.invoke(invocation(transfer, { amount: 500 }).inv)).approval!;
    const approved = invocation(transfer, { amount: 500 }, { approval: { request, decision: { approvalId: request.approvalId, decision: "approved", decidedBy: "manager" } } });
    await expect(tools.invoke(approved.inv)).resolves.toMatchObject({ status: "success", output: { transferred: 500 } });
    expect(approved.types()).toContain("TOOL_APPROVAL_GRANTED");
    expect(audit.entries.at(-1)?.approval).toEqual({ approvalId: request.approvalId, decision: "approved", decidedBy: "manager" });

    const rejected = invocation(transfer, { amount: 500 }, { approval: { request, decision: { approvalId: request.approvalId, decision: "rejected", reason: "no" } } });
    await expect(tools.invoke(rejected.inv)).resolves.toMatchObject({ status: "rejected", error: { code: "APPROVAL_REJECTED" } });
  });

  test("an approval predicate that throws requires approval (fail safe)", async () => {
    const tool = defineTool({ name: "t", description: "d", input: z.object({}), approval: { required: () => { throw new Error("x"); } }, execute: () => 1 });
    await expect(runtime().tools.invoke(invocation(tool, "{}").inv)).resolves.toMatchObject({ status: "approval_required" });
  });
});
