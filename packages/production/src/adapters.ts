import type { Chunk, MetadataFilter, VectorQuery, VectorRecord, VectorStore } from "@agent-farmework/knowledge";
import { scopeMatches, type MemoryQuery, type MemoryRecord, type MemoryStore } from "@agent-farmework/memory";
import type { IdempotencyStore, RateLimiter } from "@agent-farmework/tools";
import { tableName, type SqlClient } from "./sql.js";

// ------------------------------------------------------------------ pgvector

/**
 * PostgreSQL + pgvector reference vector store (ADR 006). Cosine distance
 * with an HNSW index; tenant visibility and metadata filters run in SQL.
 */
export class PgVectorStore implements VectorStore {
  private readonly table: string;
  constructor(private readonly client: SqlClient, private readonly options: { dimensions: number; table?: string }) {
    this.table = tableName(options.table ?? "knowledge_chunks");
  }

  async migrate(): Promise<void> {
    await this.client.query("CREATE EXTENSION IF NOT EXISTS vector");
    await this.client.query(`CREATE TABLE IF NOT EXISTS ${this.table} (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL, tenant_id TEXT, metadata JSONB NOT NULL, chunk JSONB NOT NULL,
      embedding vector(${Math.trunc(this.options.dimensions)}) NOT NULL)`);
    await this.client.query(`CREATE INDEX IF NOT EXISTS ${this.table}_embedding_idx ON ${this.table} USING hnsw (embedding vector_cosine_ops)`);
    await this.client.query(`CREATE INDEX IF NOT EXISTS ${this.table}_doc_idx ON ${this.table} (document_id)`);
  }

  async upsert(records: readonly VectorRecord[]): Promise<void> {
    for (const r of records) {
      await this.client.query(
        `INSERT INTO ${this.table} (id, document_id, tenant_id, metadata, chunk, embedding) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET metadata = EXCLUDED.metadata, chunk = EXCLUDED.chunk, embedding = EXCLUDED.embedding, tenant_id = EXCLUDED.tenant_id`,
        [r.chunk.id, r.chunk.documentId, r.chunk.tenantId ?? null, JSON.stringify(r.chunk.metadata), JSON.stringify(r.chunk), vectorLiteral(r.vector)],
      );
    }
  }

  async deleteDocument(documentId: string): Promise<void> {
    await this.client.query(`DELETE FROM ${this.table} WHERE document_id = $1`, [documentId]);
  }

  async query(vector: readonly number[], query: VectorQuery): Promise<{ chunk: Chunk; score: number }[]> {
    const { where, params } = scopeSql(query, 2);
    const { rows } = await this.client.query<{ chunk: Chunk | string; score: number | string }>(
      `SELECT chunk, 1 - (embedding <=> $1) AS score FROM ${this.table} ${where} ORDER BY embedding <=> $1 LIMIT ${Math.max(1, Math.trunc(query.k))}`,
      [vectorLiteral(vector), ...params],
    );
    return rows.map((r) => ({ chunk: parse<Chunk>(r.chunk), score: Number(r.score) }));
  }

  async chunks(query: Omit<VectorQuery, "k">): Promise<Chunk[]> {
    const { where, params } = scopeSql(query, 1);
    const { rows } = await this.client.query<{ chunk: Chunk | string }>(`SELECT chunk FROM ${this.table} ${where} LIMIT 5000`, params);
    return rows.map((r) => parse<Chunk>(r.chunk));
  }
}

function vectorLiteral(v: readonly number[]): string {
  return `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`;
}

function parse<T>(value: T | string): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : value;
}

/** Tenant visibility (tenant rows only for that tenant, global rows for all) + metadata equality / any-of. */
function scopeSql(query: { tenantId?: string; filter?: MetadataFilter }, firstParam: number): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const next = (value: unknown): string => {
    params.push(value);
    return `$${firstParam + params.length - 1}`;
  };
  clauses.push(query.tenantId === undefined ? "tenant_id IS NULL" : `(tenant_id IS NULL OR tenant_id = ${next(query.tenantId)})`);
  for (const [key, expected] of Object.entries(query.filter ?? {})) {
    const values = Array.isArray(expected) ? expected : [expected];
    clauses.push(`(${values.map((v) => `metadata @> ${next(JSON.stringify({ [key]: v }))}::jsonb`).join(" OR ")})`);
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

// ------------------------------------------------------------------ memory

/** Durable memory store in PostgreSQL. Authorization stays in `Memory`; this is storage only. */
export class PostgresMemoryStore implements MemoryStore {
  private readonly table: string;
  constructor(private readonly client: SqlClient, options: { table?: string } = {}) {
    this.table = tableName(options.table ?? "agent_memory");
  }
  async migrate(): Promise<void> {
    await this.client.query(`CREATE TABLE IF NOT EXISTS ${this.table} (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, tenant_id TEXT, user_id TEXT, record JSONB NOT NULL, expires_at TIMESTAMPTZ)`);
    await this.client.query(`CREATE INDEX IF NOT EXISTS ${this.table}_scope_idx ON ${this.table} (tenant_id, user_id, kind)`);
  }
  async put(record: MemoryRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO ${this.table} (id, kind, tenant_id, user_id, record, expires_at) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET record = EXCLUDED.record, expires_at = EXCLUDED.expires_at`,
      [record.id, record.kind, record.scope.tenantId ?? null, record.scope.userId ?? null, JSON.stringify(record), record.expiresAt ?? null],
    );
  }
  async get(id: string): Promise<MemoryRecord | undefined> {
    const { rows } = await this.client.query<{ record: MemoryRecord | string }>(`SELECT record FROM ${this.table} WHERE id = $1`, [id]);
    return rows[0] === undefined ? undefined : parse(rows[0].record);
  }
  async list(query: MemoryQuery): Promise<MemoryRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (query.kinds !== undefined) {
      params.push([...query.kinds]);
      clauses.push(`kind = ANY($${params.length})`);
    }
    if (query.scope?.tenantId !== undefined) {
      params.push(query.scope.tenantId);
      clauses.push(`tenant_id = $${params.length}`);
    }
    if (query.scope?.userId !== undefined) {
      params.push(query.scope.userId);
      clauses.push(`user_id = $${params.length}`);
    }
    const { rows } = await this.client.query<{ record: MemoryRecord | string }>(
      `SELECT record FROM ${this.table}${clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`}`,
      params,
    );
    // Remaining scope fields (agentId, entityId, conversationId) are matched in memory.
    return rows.map((r) => parse(r.record)).filter((r) => scopeMatches(r.scope, query.scope));
  }
  async delete(id: string): Promise<boolean> {
    const { rows } = await this.client.query(`DELETE FROM ${this.table} WHERE id = $1 RETURNING id`, [id]);
    return rows.length > 0;
  }
}

// ------------------------------------------------------------------ Redis

/** Minimal Redis command surface (ioredis and node-redis v4 `sendCommand` wrappers satisfy it). */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>;
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<unknown>;
}

/** Fixed-window rate limiter shared by every instance. */
export class RedisRateLimiter implements RateLimiter {
  constructor(private readonly redis: RedisLike, private readonly prefix = "af:rl:") {}
  async tryAcquire(key: string, maxCalls: number, windowMs: number): Promise<boolean> {
    const bucket = `${this.prefix}${key}:${Math.floor(Date.now() / windowMs)}`;
    const count = await this.redis.incr(bucket);
    if (count === 1) await this.redis.pexpire(bucket, windowMs);
    return count <= maxCalls;
  }
}

/** Shared idempotency store. */
export class RedisIdempotencyStore implements IdempotencyStore {
  constructor(private readonly redis: RedisLike, private readonly prefix = "af:idem:") {}
  async get(key: string): Promise<{ output: unknown } | undefined> {
    const raw = await this.redis.get(this.prefix + key);
    return raw === null ? undefined : (JSON.parse(raw) as { output: unknown });
  }
  async set(key: string, value: { output: unknown }, ttlMs: number | undefined): Promise<void> {
    const payload = JSON.stringify({ output: value.output ?? null });
    if (ttlMs === undefined) await this.redis.set(this.prefix + key, payload);
    else await this.redis.set(this.prefix + key, payload, "PX", ttlMs);
  }
}
