import type { AgentState, RunStateStore } from "@agent-farmework/core";
import type { AuditSink, IdempotencyStore, ToolAuditRecord } from "@agent-farmework/tools";
import { tableName, type SqlClient, type SqliteDatabase } from "./sql.js";

/** Durable run state in PostgreSQL (JSONB). Call `migrate()` once at deploy time. */
export class PostgresRunStateStore implements RunStateStore {
  private readonly table: string;
  constructor(private readonly client: SqlClient, options: { table?: string } = {}) {
    this.table = tableName(options.table ?? "agent_runs");
  }
  async migrate(): Promise<void> {
    await this.client.query(`CREATE TABLE IF NOT EXISTS ${this.table} (
      run_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      tenant_id TEXT,
      status TEXT NOT NULL,
      state JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL)`);
    await this.client.query(`CREATE INDEX IF NOT EXISTS ${this.table}_status_idx ON ${this.table} (status, updated_at)`);
    await this.client.query(`CREATE INDEX IF NOT EXISTS ${this.table}_tenant_idx ON ${this.table} (tenant_id, created_at)`);
  }
  async load(runId: string): Promise<AgentState | undefined> {
    const { rows } = await this.client.query<{ state: AgentState | string }>(`SELECT state FROM ${this.table} WHERE run_id = $1`, [runId]);
    const row = rows[0];
    return row === undefined ? undefined : typeof row.state === "string" ? (JSON.parse(row.state) as AgentState) : row.state;
  }
  async save(state: AgentState): Promise<void> {
    await this.client.query(
      `INSERT INTO ${this.table} (run_id, agent_id, tenant_id, status, state, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (run_id) DO UPDATE SET status = EXCLUDED.status, state = EXCLUDED.state, updated_at = EXCLUDED.updated_at`,
      [state.runId, state.agentId, state.user?.tenantId ?? null, state.status, JSON.stringify(state), state.createdAt, state.updatedAt],
    );
  }
  /** Data retention: delete terminal runs older than `before`. Returns the count. */
  async deleteOlderThan(before: Date): Promise<number> {
    const { rows } = await this.client.query<{ n: number }>(
      `WITH d AS (DELETE FROM ${this.table} WHERE updated_at < $1 AND status IN ('COMPLETED','FAILED','CANCELLED','TIMED_OUT','APPROVAL_EXPIRED') RETURNING 1) SELECT count(*)::int AS n FROM d`,
      [before.toISOString()],
    );
    return rows[0]?.n ?? 0;
  }
}

/** Durable run state in SQLite. Good for development, single-node deployments and tests. */
export class SqliteRunStateStore implements RunStateStore {
  constructor(private readonly db: SqliteDatabase) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_runs (
      run_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, tenant_id TEXT, status TEXT NOT NULL,
      state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  }
  async load(runId: string): Promise<AgentState | undefined> {
    const row = this.db.prepare("SELECT state FROM agent_runs WHERE run_id = ?").get(runId) as { state: string } | undefined;
    return row === undefined ? undefined : (JSON.parse(row.state) as AgentState);
  }
  async save(state: AgentState): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO agent_runs (run_id, agent_id, tenant_id, status, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET status = excluded.status, state = excluded.state, updated_at = excluded.updated_at`,
      )
      .run(state.runId, state.agentId, state.user?.tenantId ?? null, state.status, JSON.stringify(state), state.createdAt, state.updatedAt);
  }
}

/** Append-only tool audit log in PostgreSQL. */
export class PostgresAuditSink implements AuditSink {
  private readonly table: string;
  constructor(private readonly client: SqlClient, options: { table?: string } = {}) {
    this.table = tableName(options.table ?? "tool_audit");
  }
  async migrate(): Promise<void> {
    await this.client.query(`CREATE TABLE IF NOT EXISTS ${this.table} (
      audit_id TEXT PRIMARY KEY, recorded_at TIMESTAMPTZ NOT NULL, run_id TEXT NOT NULL, tool_call_id TEXT NOT NULL,
      agent_id TEXT NOT NULL, user_id TEXT, tenant_id TEXT, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, record JSONB NOT NULL)`);
  }
  async record(entry: ToolAuditRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO ${this.table} (audit_id, recorded_at, run_id, tool_call_id, agent_id, user_id, tenant_id, tool_name, outcome, record)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [entry.auditId, entry.recordedAt, entry.runId, entry.toolCallId, entry.agentId, entry.userId ?? null, entry.tenantId ?? null, entry.toolName, entry.outcome, JSON.stringify(entry)],
    );
  }
}

/** Shared idempotency store in PostgreSQL (safe across instances). */
export class PostgresIdempotencyStore implements IdempotencyStore {
  private readonly table: string;
  constructor(private readonly client: SqlClient, options: { table?: string } = {}) {
    this.table = tableName(options.table ?? "tool_idempotency");
  }
  async migrate(): Promise<void> {
    await this.client.query(`CREATE TABLE IF NOT EXISTS ${this.table} (key TEXT PRIMARY KEY, output JSONB, expires_at TIMESTAMPTZ)`);
  }
  async get(key: string): Promise<{ output: unknown } | undefined> {
    const { rows } = await this.client.query<{ output: unknown }>(`SELECT output FROM ${this.table} WHERE key = $1 AND (expires_at IS NULL OR expires_at > now())`, [key]);
    return rows[0] === undefined ? undefined : { output: typeof rows[0].output === "string" ? JSON.parse(rows[0].output) : rows[0].output };
  }
  async set(key: string, value: { output: unknown }, ttlMs: number | undefined): Promise<void> {
    await this.client.query(
      `INSERT INTO ${this.table} (key, output, expires_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET output = EXCLUDED.output, expires_at = EXCLUDED.expires_at`,
      [key, JSON.stringify(value.output ?? null), ttlMs === undefined ? null : new Date(Date.now() + ttlMs).toISOString()],
    );
  }
}
