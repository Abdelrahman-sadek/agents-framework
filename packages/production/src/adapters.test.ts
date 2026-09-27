import { createMemory } from "@agent-framework/memory";
import { ToolRuntime, defineTool } from "@agent-framework/tools";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { PgVectorStore, PostgresMemoryStore, RedisIdempotencyStore, RedisRateLimiter, type RedisLike } from "./adapters.js";
import type { SqlClient } from "./sql.js";

function recordingClient(rows: (text: string) => unknown[] = () => []) {
  const queries: { text: string; params: readonly unknown[] }[] = [];
  const client: SqlClient = {
    query: async (text, params = []) => {
      queries.push({ text, params });
      return { rows: rows(text) as never[] };
    },
  };
  return { client, queries };
}

describe("PgVectorStore", () => {
  test("creates an HNSW-indexed table and upserts vectors", async () => {
    const { client, queries } = recordingClient();
    const store = new PgVectorStore(client, { dimensions: 3 });
    await store.migrate();
    expect(queries.map((q) => q.text).join("\n")).toMatch(/CREATE EXTENSION IF NOT EXISTS vector[\s\S]*vector\(3\)[\s\S]*USING hnsw \(embedding vector_cosine_ops\)/);
    await store.upsert([{ chunk: { id: "d#0", documentId: "d", index: 0, text: "t", metadata: { dept: "hr" }, tenantId: "acme" }, vector: [0.1, 0.2, Number.NaN] }]);
    expect(queries.at(-1)?.params).toEqual(["d#0", "d", "acme", '{"dept":"hr"}', expect.any(String), "[0.1,0.2,0]"]);
  });

  test("queries with tenant visibility and parameterized metadata filters", async () => {
    const { client, queries } = recordingClient(() => [{ chunk: { id: "d#0", documentId: "d", index: 0, text: "t", metadata: {} }, score: "0.91" }]);
    const store = new PgVectorStore(client, { dimensions: 2 });
    const hits = await store.query([1, 0], { k: 3, tenantId: "acme", filter: { dept: ["hr", "it"], lang: "en" } });
    expect(hits[0]).toMatchObject({ score: 0.91, chunk: { id: "d#0" } });
    const q = queries.at(-1)!;
    expect(q.text).toContain("ORDER BY embedding <=> $1 LIMIT 3");
    expect(q.text).toContain("(tenant_id IS NULL OR tenant_id = $2)");
    expect(q.text).toContain("(metadata @> $3::jsonb OR metadata @> $4::jsonb) AND (metadata @> $5::jsonb)");
    expect(q.params).toEqual(["[1,0]", "acme", '{"dept":"hr"}', '{"dept":"it"}', '{"lang":"en"}']);
    await store.chunks({});
    expect(queries.at(-1)?.text).toContain("WHERE tenant_id IS NULL");
  });
});

describe("PostgresMemoryStore", () => {
  test("backs Memory with authorization still enforced by Memory", async () => {
    const table = new Map<string, string>();
    const client: SqlClient = {
      query: async (text, params = []) => {
        if (text.startsWith("INSERT")) table.set(String(params[0]), String(params[4]));
        if (text.startsWith("SELECT record FROM agent_memory WHERE id")) return { rows: table.has(String(params[0])) ? [{ record: table.get(String(params[0])) }] : [] } as never;
        if (text.startsWith("SELECT record")) return { rows: [...table.values()].map((record) => ({ record })) } as never;
        if (text.startsWith("DELETE")) return { rows: table.delete(String(params[0])) ? [{ id: params[0] }] : [] } as never;
        return { rows: [] };
      },
    };
    const memory = createMemory({ store: new PostgresMemoryStore(client) });
    const alice = { userId: "alice", tenantId: "acme" };
    await memory.store({ kind: "user", content: "likes tea", scope: { tenantId: "acme", userId: "alice" } }, { user: alice });
    expect((await memory.search("tea", {}, { user: alice }))[0]?.record.content).toBe("likes tea");
    expect(await memory.search("tea", {}, { user: { userId: "eve", tenantId: "globex" } })).toEqual([]);
    expect(await memory.forget({ tenantId: "acme", userId: "alice" }, { user: alice })).toBe(1);
  });
});

describe("Redis stores", () => {
  function fakeRedis(): RedisLike {
    const data = new Map<string, string>();
    return {
      get: async (k) => data.get(k) ?? null,
      set: async (k, v) => void data.set(k, v),
      incr: async (k) => {
        const n = Number(data.get(k) ?? "0") + 1;
        data.set(k, String(n));
        return n;
      },
      pexpire: async () => 1,
    };
  }

  test("rate limiting and idempotency are shared across ToolRuntime instances", async () => {
    const redis = fakeRedis();
    const execute = vi.fn(async ({ id }: { id: string }) => ({ charged: id }));
    const charge = defineTool({ name: "charge", description: "d", input: z.object({ id: z.string() }), idempotency: { key: (i) => i.id }, rateLimit: { maxCalls: 2, windowMs: 60_000 }, execute });
    const make = () => new ToolRuntime({ rateLimiter: new RedisRateLimiter(redis), idempotency: new RedisIdempotencyStore(redis) });
    const agent = { agentId: "a", name: "a", permissions: [] };
    const first = await make().execute(charge, { id: "x" }, { agent });
    const duplicate = await make().execute(charge, { id: "x" }, { agent });
    expect(first.output).toEqual({ charged: "x" });
    expect(duplicate).toMatchObject({ cached: true, output: { charged: "x" } });
    expect(execute).toHaveBeenCalledOnce();
    await make().execute(charge, { id: "y" }, { agent });
    expect((await make().execute(charge, { id: "z" }, { agent })).error?.code).toBe("RATE_LIMITED");
  });
});
