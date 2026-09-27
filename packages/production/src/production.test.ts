import { InMemoryRunStateStore, createRuntime, defineAgent, sequentialIds, type AgentState } from "@agent-framework/core";
import { createScriptedProvider, type ScriptedStep } from "@agent-framework/core/testing";
import { ToolRuntime, defineTool } from "@agent-framework/tools";
import { describe, expect, test, vi } from "vitest";

/** node:sqlite ships with Node ≥ 22.5; SQLite-backed tests are skipped on older runtimes. */
const hasSqlite = await import("node:sqlite").then(
  () => true,
  () => false,
);
import { z } from "zod";
import { createFramework } from "./framework.js";
import { createHealthCheck } from "./health.js";
import { InMemoryJobQueue, SqliteJobQueue, type JobQueue } from "./queue.js";
import { AgentService } from "./service.js";
import { openSqlite, tableName, type SqlClient } from "./sql.js";
import { PostgresRunStateStore, SqliteRunStateStore } from "./state-stores.js";
import { AgentWorker } from "./worker.js";

function system(steps: ScriptedStep[], options: { store?: InMemoryRunStateStore | SqliteRunStateStore; queue?: JobQueue } = {}) {
  const provider = createScriptedProvider(steps);
  const executed: number[] = [];
  const refund = defineTool({
    name: "refund",
    description: "Refund",
    input: z.object({ amount: z.number() }),
    approval: { required: ({ amount }) => amount > 100 },
    idempotency: { key: ({ amount }) => `refund-${amount}` },
    execute: async ({ amount }) => {
      executed.push(amount);
      return { refunded: amount };
    },
  });
  const stateStore = options.store ?? new InMemoryRunStateStore();
  const runtime = createRuntime({ providers: [provider], tools: new ToolRuntime(), stateStore, ids: sequentialIds() });
  const agent = defineAgent({ name: "support", model: { providerId: "scripted", modelId: "m" }, tools: [refund] });
  const queue = options.queue ?? new InMemoryJobQueue();
  const service = new AgentService({ queue, runtime, agents: ["support"], ids: sequentialIds() });
  const worker = new AgentWorker({ queue, runtime, agents: [agent], workerId: "w1", retryDelayMs: 1 });
  return { provider, runtime, agent, queue, service, worker, executed, stateStore };
}

describe("queue → worker → state", () => {
  test("API submit returns immediately; a worker completes the run", async () => {
    const s = system([{ text: "Hello" }]);
    const { runId, deduplicated } = await s.service.submit("support", { input: "hi", user: { userId: "u" } });
    expect(deduplicated).toBe(false);
    expect((await s.service.status(runId))?.status).toBe("QUEUED");
    expect(await s.worker.processNext()).toBe("ran");
    expect(await s.service.status(runId)).toMatchObject({ status: "COMPLETED", output: "Hello" });
    expect(await s.worker.processNext()).toBe(false);
  });

  test("idempotent submission with a caller-supplied run id", async () => {
    const s = system([{ text: "once" }]);
    await s.service.submit("support", { input: "x", runId: "req-123" });
    expect(await s.service.submit("support", { input: "x", runId: "req-123" })).toMatchObject({ deduplicated: true });
    await expect(s.service.submit("nope", { input: "x" })).rejects.toThrow(/Unknown agent/);
  });

  test("approval flow across requests: submit → wait → approve → resume", async () => {
    const s = system([{ toolCalls: [{ id: "c1", name: "refund", arguments: { amount: 500 } }] }, { text: "Refunded." }]);
    const { runId } = await s.service.submit("support", { input: "refund 500" });
    await s.worker.processNext();
    const waiting = await s.service.status(runId);
    expect(waiting?.status).toBe("WAITING_FOR_APPROVAL");
    const approvalId = waiting?.pendingApprovals[0]?.approvalId as string;
    await expect(s.service.approve(runId, [{ approvalId: "forged", decision: "approved" }])).rejects.toThrow(/not pending/);
    await s.service.approve(runId, [{ approvalId, decision: "approved", decidedBy: "lead" }]);
    expect(await s.worker.processNext()).toBe("resumed");
    expect(await s.service.status(runId)).toMatchObject({ status: "COMPLETED", output: "Refunded." });
    expect(s.executed).toEqual([500]);
  });

  test("duplicate delivery of a finished job is acknowledged without re-running", async () => {
    const s = system([{ text: "done" }]);
    const { runId, jobId } = await s.service.submit("support", { input: "x" });
    const lease = await s.queue.lease("dead-worker", 1, Date.now());
    expect(lease?.id).toBe(jobId);
    await s.runtime.run(s.agent, { input: "x", runId }); // the dead worker actually finished before dying
    await new Promise((r) => setTimeout(r, 5)); // lease expires
    expect(await s.worker.processNext()).toBe("duplicate");
    expect(s.provider.requests).toHaveLength(1);
  });

  test("a crashed worker's run is recovered by another worker after lease expiry", async () => {
    const s = system([{ toolCalls: [{ id: "c1", name: "refund", arguments: { amount: 50 } }] }, { text: "Refunded 50." }]);
    const { runId } = await s.service.submit("support", { input: "refund 50" });
    await s.queue.lease("dead-worker", 1, Date.now());
    // Simulate the crash: the checkpoint before tool execution is persisted as RUNNING.
    const now = new Date().toISOString();
    const crashed: AgentState = {
      runId,
      agentId: "support",
      status: "RUNNING",
      input: "refund 50",
      messages: [
        { role: "user", content: "refund 50" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "refund", arguments: '{"amount":50}' }] },
      ],
      steps: [{ stepId: "s1", index: 0, kind: "llm_call", status: "COMPLETED", startedAt: now, llmCallId: "l1" }],
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, totalTokens: 15, estimatedCostUsd: 0, llmCalls: 1, toolCalls: 0 },
      pendingApprovals: [],
      contextItems: [],
      corrections: { output: 0, reflection: 0 },
      limits: { maxSteps: 10, maxToolCalls: 25, maxTokens: undefined, maxCost: undefined, timeoutMs: 120_000, maxLLMRetries: 2, maxOutputCorrections: 1, maxReflectionAttempts: 1 },
      metadata: {},
      eventSequence: 5,
      createdAt: now,
      updatedAt: now,
    };
    await s.stateStore.save(crashed);
    s.provider.requests.length = 0;
    await new Promise((r) => setTimeout(r, 5));
    // Drop the first scripted step (already consumed by the "dead" worker in reality).
    await s.provider.generate({ modelId: "m", messages: [] });
    expect(await s.worker.processNext()).toBe("recovered");
    expect(await s.service.status(runId)).toMatchObject({ status: "COMPLETED", output: "Refunded 50." });
    expect(s.executed).toEqual([50]);
  });

  test("infrastructure failures are retried with backoff, then marked failed", async () => {
    const s = system([{ text: "x" }]);
    const broken = { load: vi.fn(async () => { throw new Error("db down"); }), save: vi.fn() };
    const runtime = createRuntime({ providers: [createScriptedProvider([])], stateStore: broken as never });
    const queue = new InMemoryJobQueue();
    await queue.enqueue({ id: "j", agent: "support", runId: "r", payload: { kind: "run", input: "x" }, maxAttempts: 2 });
    const worker = new AgentWorker({ queue, runtime, agents: [s.agent], retryDelayMs: 1 });
    expect(await worker.processNext()).toBe("retry");
    await new Promise((r) => setTimeout(r, 5));
    expect(await worker.processNext()).toBe("failed");
    expect(await queue.get("j")).toMatchObject({ status: "failed", lastError: "db down", attempts: 2 });
  });

  test("start/stop: graceful shutdown drains in-flight jobs", async () => {
    const s = system([{ text: "a" }, { text: "b" }]);
    await s.service.submit("support", { input: "1" });
    await s.service.submit("support", { input: "2" });
    s.worker.start();
    await vi.waitFor(async () => expect((await s.service.status("run_2"))?.status).toBe("COMPLETED"), { timeout: 2000 });
    expect(await s.worker.stop({ timeoutMs: 1000 })).toBe(0);
  });
});

describe.skipIf(!hasSqlite)("SQLite durability", () => {
  test("run state and jobs survive a new process (reopened database)", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const path = join(mkdtempSync(join(tmpdir(), "af-sqlite-")), "agents.db");
    const db1 = await openSqlite(path);
    const s1 = system([{ toolCalls: [{ id: "c1", name: "refund", arguments: { amount: 900 } }] }], { store: new SqliteRunStateStore(db1), queue: new SqliteJobQueue(db1) });
    const { runId } = await s1.service.submit("support", { input: "refund 900" });
    await s1.worker.processNext();
    const approvalId = (await s1.service.status(runId))?.pendingApprovals[0]?.approvalId as string;

    // "Restart": new database handle, new runtime, new worker.
    const db2 = await openSqlite(path);
    const s2 = system([{ text: "Refunded 900." }], { store: new SqliteRunStateStore(db2), queue: new SqliteJobQueue(db2) });
    expect((await s2.service.status(runId))?.status).toBe("WAITING_FOR_APPROVAL");
    await s2.service.approve(runId, [{ approvalId, decision: "approved" }]);
    expect(await s2.worker.processNext()).toBe("resumed");
    expect(await s2.service.status(runId)).toMatchObject({ status: "COMPLETED", output: "Refunded 900." });
    expect(s2.executed).toEqual([900]);
  });
});

describe("PostgreSQL adapters", () => {
  test("issue parameterized SQL and parse JSONB", async () => {
    const queries: { text: string; params?: readonly unknown[] }[] = [];
    const client: SqlClient = {
      query: async (text, params) => {
        queries.push({ text, ...(params === undefined ? {} : { params }) });
        return { rows: text.startsWith("SELECT") ? ([{ state: '{"runId":"r1","status":"COMPLETED"}' }] as never[]) : [] };
      },
    };
    const store = new PostgresRunStateStore(client);
    await store.migrate();
    expect((await store.load("r1"))?.status).toBe("COMPLETED");
    expect(queries.at(-1)).toMatchObject({ text: expect.stringContaining("WHERE run_id = $1"), params: ["r1"] });
    expect(() => tableName("runs; DROP TABLE x")).toThrow();
  });
});

describe("operations", () => {
  test("health checks report ok / degraded / down", async () => {
    const ok = await createHealthCheck({ db: async () => 1 }).run();
    expect(ok.status).toBe("ok");
    const degraded = await createHealthCheck({ db: async () => 1, cache: { check: async () => { throw new Error("x"); }, critical: false } }).run();
    expect(degraded.status).toBe("degraded");
    const down = await createHealthCheck({ db: { check: () => new Promise(() => {}), timeoutMs: 10 } }).run();
    expect(down).toMatchObject({ status: "down", checks: { db: { ok: false, error: "timeout" } } });
  });

  test("createFramework validates config and enforces production requirements", () => {
    const provider = createScriptedProvider([]);
    expect(createFramework({ environment: "development", llm: { providers: [provider] } }).runtime).toBeDefined();
    expect(() => createFramework({ environment: "staging" as never, llm: { providers: [provider] } })).toThrow(/Invalid framework configuration/);
    expect(() => createFramework({ environment: "development", llm: { providers: [] } })).toThrow();
    expect(() => createFramework({ environment: "development", llm: { providers: [provider] }, limits: { maxStepz: 3 } as never })).toThrow();
    expect(() => createFramework({ environment: "production", llm: { providers: [provider] } })).toThrow(/durable RunStateStore[\s\S]*durable AuditSink[\s\S]*maxCost/);
    const durable = { load: async () => undefined, save: async () => {} };
    const audit = { record: () => {} };
    expect(createFramework({ environment: "production", llm: { providers: [provider] }, persistence: { runs: durable }, tools: { audit }, limits: { maxCost: 1 } }).environment).toBe("production");
  });
});
