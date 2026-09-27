import { AuthorizationError, InMemoryEventSink, createRuntime, defineAgent, sequentialIds, type Principal } from "@agent-framework/core";
import { createScriptedProvider } from "@agent-framework/core/testing";
import { hashingEmbedder } from "@agent-framework/knowledge";
import { ToolRuntime } from "@agent-framework/tools";
import { describe, expect, test } from "vitest";
import { createMemory } from "./memory.js";

const alice: Principal = { userId: "alice", tenantId: "acme" };
const bob: Principal = { userId: "bob", tenantId: "acme" };
const eve: Principal = { userId: "eve", tenantId: "globex" };
const as = (user: Principal) => ({ user, agentId: "assistant" });
const mine = (user: Principal) => ({ tenantId: user.tenantId as string, userId: user.userId });

describe("memory policy", () => {
  test("stores accepted candidates with provenance and TTL", async () => {
    let now = Date.parse("2026-01-01T00:00:00Z");
    const memory = createMemory({ clock: { now: () => new Date(now) }, ids: sequentialIds(), policy: { ttlMs: { episodic: 1000 } } });
    const result = await memory.store({ kind: "episodic", content: "Resolved ticket 7", scope: mine(alice), provenance: { source: "agent", runId: "r1" } }, as(alice));
    expect(result).toMatchObject({ stored: true, record: { id: "memory_1", provenance: { runId: "r1" }, expiresAt: "2026-01-01T00:00:01.000Z" } });
    now += 2000;
    expect(await memory.get("memory_1", as(alice))).toBeUndefined();
    expect(await memory.purgeExpired()).toBe(1);
  });

  test.each([
    [{ confidence: 0.3 }, /confidence/],
    [{ content: "my password: hunter2" }, /secret/],
    [{ content: "card 4111 1111 1111 1111" }, /secret/],
    [{ content: "x".repeat(3000) }, /too long/],
  ])("rejects %j", async (override, reason) => {
    const memory = createMemory();
    const result = await memory.store({ kind: "user", content: "likes tea", scope: mine(alice), ...override }, as(alice));
    expect(result.stored).toBe(false);
    if (!result.stored) expect(result.reason).toMatch(reason);
  });

  test("allowedKinds and custom rules", async () => {
    const memory = createMemory({ policy: { allowedKinds: ["user"], reject: (c) => (c.content.includes("politics") ? "off-topic" : undefined) } });
    expect((await memory.store({ kind: "semantic", content: "fact", scope: mine(alice) }, as(alice))).stored).toBe(false);
    expect(await memory.store({ kind: "user", content: "talks politics", scope: mine(alice) }, as(alice))).toEqual({ stored: false, reason: "off-topic" });
  });
});

describe("memory isolation", () => {
  test("users only see their own memories; tenants never see each other", async () => {
    const memory = createMemory();
    await memory.store({ kind: "user", content: "Alice prefers email updates", scope: mine(alice) }, as(alice));
    await memory.store({ kind: "semantic", content: "Acme fiscal year starts in April", scope: { tenantId: "acme" } }, as(alice));
    const search = async (user: Principal) => (await memory.search("email updates fiscal year", {}, as(user))).map((r) => r.record.content);
    expect(await search(alice)).toHaveLength(2);
    expect(await search(bob)).toEqual(["Acme fiscal year starts in April"]);
    expect(await search(eve)).toEqual([]);
  });

  test("cannot write into another user's or tenant's scope", async () => {
    const memory = createMemory();
    await expect(memory.store({ kind: "user", content: "x likes y", scope: mine(bob) }, as(alice))).rejects.toThrow(AuthorizationError);
    await expect(memory.store({ kind: "user", content: "x likes y", scope: mine(eve) }, as(alice))).rejects.toThrow(AuthorizationError);
    await expect(memory.store({ kind: "semantic", content: "global fact", scope: {} }, as(alice))).rejects.toThrow(/memory.admin/);
  });

  test("update, delete and forget respect ownership", async () => {
    const memory = createMemory();
    const r = await memory.store({ kind: "user", content: "likes tea", scope: mine(alice) }, as(alice));
    if (!r.stored) throw new Error("expected stored");
    expect(await memory.delete(r.record.id, as(bob))).toBe(false);
    await expect(memory.update(r.record.id, { content: "likes coffee" }, as(bob))).rejects.toThrow();
    expect((await memory.update(r.record.id, { content: "likes coffee" }, as(alice))).content).toBe("likes coffee");
    await memory.store({ kind: "user", content: "lives in Cairo", scope: mine(alice) }, as(alice));
    expect(await memory.forget(mine(alice), as(alice))).toBe(2);
    expect(await memory.search("coffee Cairo", {}, as(alice))).toEqual([]);
  });
});

describe("memory in agents", () => {
  test("semantic search with an embedder ranks by similarity and confidence", async () => {
    const memory = createMemory({ embedder: hashingEmbedder() });
    await memory.store({ kind: "user", content: "Prefers vegetarian restaurants", scope: mine(alice), confidence: 0.9 }, as(alice));
    await memory.store({ kind: "user", content: "Works on the payments team", scope: mine(alice), confidence: 0.9 }, as(alice));
    const [top] = await memory.search("vegetarian restaurants dinner", {}, as(alice));
    expect(top?.record.content).toContain("vegetarian");
  });

  test("context provider recalls memories and conversation history", async () => {
    const memory = createMemory();
    await memory.store({ kind: "user", content: "Alice's timezone is Africa/Cairo", scope: mine(alice) }, as(alice));
    await memory.appendConversation("conv-1", [{ role: "user", content: "Book a meeting with Bob" }, { role: "assistant", content: "Which day?" }], as(alice));
    const provider = createScriptedProvider([{ text: "Booked for Tuesday." }]);
    const sink = new InMemoryEventSink();
    const runtime = createRuntime({ providers: [provider], events: sink });
    const agent = defineAgent({ name: "assistant", model: { providerId: "scripted", modelId: "m" }, context: [memory.asContextProvider()], runtime });
    await agent.run({ input: "Tuesday, in my timezone", user: alice, metadata: { conversationId: "conv-1" } });
    const context = provider.requests[0]?.messages.find((m) => m.content.includes("<context>"))?.content ?? "";
    expect(context).toContain("user: Book a meeting with Bob");
    expect(context).toContain("timezone is Africa/Cairo");
    expect(sink.ofType("MEMORY_READ")[0]?.payload.resultCount).toBeGreaterThan(0);
  });

  test("remember tool stores for the calling user only, through the policy", async () => {
    const memory = createMemory();
    const [remember] = memory.asTools();
    const tools = new ToolRuntime();
    const agent = { agentId: "assistant", name: "assistant", permissions: [] };
    const ok = await tools.execute(remember!, { content: "Prefers short answers" }, { agent, user: alice });
    const secret = await tools.execute(remember!, { content: "api_key=sk-abcdefghijklmnopqrstuv" }, { agent, user: alice });
    expect(ok.output).toMatchObject({ stored: true });
    expect(secret.output).toMatchObject({ stored: false });
    expect(await memory.search("short answers", {}, as(bob))).toEqual([]);
  });

  test("recordEpisode stores an episodic memory for the user", async () => {
    const memory = createMemory();
    const r = await memory.recordEpisode({ summary: "Refunded order 7", runId: "run-9", outcome: "approved" }, as(alice));
    expect(r).toMatchObject({ stored: true, record: { kind: "episodic", provenance: { runId: "run-9", createdBy: "assistant" } } });
  });
});
