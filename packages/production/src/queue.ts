import type { ApprovalDecision, Principal } from "@agent-farmework/core";
import { tableName, type SqlClient, type SqliteDatabase } from "./sql.js";

/** Serializable work item. Jobs reference runs; run state lives in the RunStateStore. */
export type JobPayload =
  | { kind: "run"; input: unknown; user?: Principal; metadata?: Record<string, unknown> }
  | { kind: "resume"; approvals: ApprovalDecision[] };

export interface Job {
  id: string;
  agent: string;
  runId: string;
  payload: JobPayload;
  status: "queued" | "leased" | "done" | "failed";
  attempts: number;
  maxAttempts: number;
  availableAt: number;
  leaseOwner?: string;
  leaseUntil?: number;
  lastError?: string;
}

export interface NewJob {
  id: string;
  agent: string;
  runId: string;
  payload: JobPayload;
  maxAttempts?: number;
  availableAt?: number;
}

/**
 * Durable queue port with leases. A job leased by a worker that dies becomes
 * available again when its lease expires (at-least-once delivery); workers
 * make processing idempotent through run state.
 */
export interface JobQueue {
  enqueue(job: NewJob): Promise<Job>;
  /** Atomically lease the next available job. */
  lease(workerId: string, leaseMs: number, now?: number): Promise<Job | undefined>;
  heartbeat(jobId: string, workerId: string, leaseMs: number, now?: number): Promise<boolean>;
  complete(jobId: string, workerId: string): Promise<void>;
  /** Retry later, or mark failed when attempts are exhausted. */
  fail(jobId: string, workerId: string, error: string, retryAt?: number): Promise<void>;
  get(jobId: string): Promise<Job | undefined>;
}

export class InMemoryJobQueue implements JobQueue {
  private readonly jobs = new Map<string, Job>();

  async enqueue(job: NewJob): Promise<Job> {
    const existing = this.jobs.get(job.id);
    if (existing !== undefined) return { ...existing };
    const created: Job = { ...job, status: "queued", attempts: 0, maxAttempts: job.maxAttempts ?? 3, availableAt: job.availableAt ?? Date.now() };
    this.jobs.set(job.id, created);
    return { ...created };
  }

  async lease(workerId: string, leaseMs: number, now = Date.now()): Promise<Job | undefined> {
    for (const job of [...this.jobs.values()].sort((a, b) => a.availableAt - b.availableAt)) {
      const expired = job.status === "leased" && (job.leaseUntil ?? 0) <= now;
      if ((job.status === "queued" && job.availableAt <= now) || expired) {
        job.status = "leased";
        job.leaseOwner = workerId;
        job.leaseUntil = now + leaseMs;
        job.attempts += 1;
        return { ...job };
      }
    }
    return undefined;
  }

  async heartbeat(jobId: string, workerId: string, leaseMs: number, now = Date.now()): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (job?.status !== "leased" || job.leaseOwner !== workerId) return false;
    job.leaseUntil = now + leaseMs;
    return true;
  }

  async complete(jobId: string, workerId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (job?.leaseOwner === workerId) job.status = "done";
  }

  async fail(jobId: string, workerId: string, error: string, retryAt?: number): Promise<void> {
    const job = this.jobs.get(jobId);
    if (job?.leaseOwner !== workerId) return;
    job.lastError = error;
    delete job.leaseOwner;
    delete job.leaseUntil;
    if (retryAt === undefined || job.attempts >= job.maxAttempts) job.status = "failed";
    else {
      job.status = "queued";
      job.availableAt = retryAt;
    }
  }

  async get(jobId: string): Promise<Job | undefined> {
    const job = this.jobs.get(jobId);
    return job === undefined ? undefined : { ...job };
  }
}

type Row = { id: string; agent: string; run_id: string; payload: string | JobPayload; status: Job["status"]; attempts: number; max_attempts: number; available_at: string | number; lease_owner: string | null; lease_until: string | number | null; last_error: string | null };

function fromRow(row: Row): Job {
  return {
    id: row.id,
    agent: row.agent,
    runId: row.run_id,
    payload: typeof row.payload === "string" ? (JSON.parse(row.payload) as JobPayload) : row.payload,
    status: row.status,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    availableAt: Number(row.available_at),
    ...(row.lease_owner === null ? {} : { leaseOwner: row.lease_owner }),
    ...(row.lease_until === null ? {} : { leaseUntil: Number(row.lease_until) }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
  };
}

/** PostgreSQL queue using `FOR UPDATE SKIP LOCKED` so many workers can lease concurrently. */
export class PostgresJobQueue implements JobQueue {
  private readonly table: string;
  constructor(private readonly client: SqlClient, options: { table?: string } = {}) {
    this.table = tableName(options.table ?? "agent_jobs");
  }
  async migrate(): Promise<void> {
    await this.client.query(`CREATE TABLE IF NOT EXISTS ${this.table} (
      id TEXT PRIMARY KEY, agent TEXT NOT NULL, run_id TEXT NOT NULL, payload JSONB NOT NULL, status TEXT NOT NULL,
      attempts INT NOT NULL DEFAULT 0, max_attempts INT NOT NULL, available_at BIGINT NOT NULL,
      lease_owner TEXT, lease_until BIGINT, last_error TEXT)`);
    await this.client.query(`CREATE INDEX IF NOT EXISTS ${this.table}_ready_idx ON ${this.table} (status, available_at)`);
  }
  async enqueue(job: NewJob): Promise<Job> {
    await this.client.query(
      `INSERT INTO ${this.table} (id, agent, run_id, payload, status, max_attempts, available_at) VALUES ($1,$2,$3,$4,'queued',$5,$6) ON CONFLICT (id) DO NOTHING`,
      [job.id, job.agent, job.runId, JSON.stringify(job.payload), job.maxAttempts ?? 3, job.availableAt ?? Date.now()],
    );
    return (await this.get(job.id)) as Job;
  }
  async lease(workerId: string, leaseMs: number, now = Date.now()): Promise<Job | undefined> {
    const { rows } = await this.client.query<Row>(
      `UPDATE ${this.table} SET status = 'leased', lease_owner = $1, lease_until = $2, attempts = attempts + 1
       WHERE id = (SELECT id FROM ${this.table}
                   WHERE (status = 'queued' AND available_at <= $3) OR (status = 'leased' AND lease_until <= $3)
                   ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING *`,
      [workerId, now + leaseMs, now],
    );
    return rows[0] === undefined ? undefined : fromRow(rows[0]);
  }
  async heartbeat(jobId: string, workerId: string, leaseMs: number, now = Date.now()): Promise<boolean> {
    const { rows } = await this.client.query(`UPDATE ${this.table} SET lease_until = $1 WHERE id = $2 AND lease_owner = $3 AND status = 'leased' RETURNING id`, [now + leaseMs, jobId, workerId]);
    return rows.length > 0;
  }
  async complete(jobId: string, workerId: string): Promise<void> {
    await this.client.query(`UPDATE ${this.table} SET status = 'done' WHERE id = $1 AND lease_owner = $2`, [jobId, workerId]);
  }
  async fail(jobId: string, workerId: string, error: string, retryAt?: number): Promise<void> {
    await this.client.query(
      `UPDATE ${this.table} SET last_error = $3, lease_owner = NULL, lease_until = NULL,
         status = CASE WHEN $4::bigint IS NULL OR attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
         available_at = COALESCE($4::bigint, available_at)
       WHERE id = $1 AND lease_owner = $2`,
      [jobId, workerId, error, retryAt ?? null],
    );
  }
  async get(jobId: string): Promise<Job | undefined> {
    const { rows } = await this.client.query<Row>(`SELECT * FROM ${this.table} WHERE id = $1`, [jobId]);
    return rows[0] === undefined ? undefined : fromRow(rows[0]);
  }
}

/** SQLite queue (single node; leasing is serialized by SQLite's write lock). */
export class SqliteJobQueue implements JobQueue {
  constructor(private readonly db: SqliteDatabase) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_jobs (
      id TEXT PRIMARY KEY, agent TEXT NOT NULL, run_id TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL, available_at INTEGER NOT NULL,
      lease_owner TEXT, lease_until INTEGER, last_error TEXT)`);
  }
  async enqueue(job: NewJob): Promise<Job> {
    this.db
      .prepare(`INSERT OR IGNORE INTO agent_jobs (id, agent, run_id, payload, status, max_attempts, available_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)`)
      .run(job.id, job.agent, job.runId, JSON.stringify(job.payload), job.maxAttempts ?? 3, job.availableAt ?? Date.now());
    return (await this.get(job.id)) as Job;
  }
  async lease(workerId: string, leaseMs: number, now = Date.now()): Promise<Job | undefined> {
    const row = this.db
      .prepare(
        `UPDATE agent_jobs SET status = 'leased', lease_owner = ?, lease_until = ?, attempts = attempts + 1
         WHERE id = (SELECT id FROM agent_jobs WHERE (status = 'queued' AND available_at <= ?) OR (status = 'leased' AND lease_until <= ?) ORDER BY available_at LIMIT 1)
         RETURNING *`,
      )
      .get(workerId, now + leaseMs, now, now) as Row | undefined;
    return row === undefined ? undefined : fromRow(row);
  }
  async heartbeat(jobId: string, workerId: string, leaseMs: number, now = Date.now()): Promise<boolean> {
    const row = this.db.prepare(`UPDATE agent_jobs SET lease_until = ? WHERE id = ? AND lease_owner = ? AND status = 'leased' RETURNING id`).get(now + leaseMs, jobId, workerId);
    return row !== undefined;
  }
  async complete(jobId: string, workerId: string): Promise<void> {
    this.db.prepare(`UPDATE agent_jobs SET status = 'done' WHERE id = ? AND lease_owner = ?`).run(jobId, workerId);
  }
  async fail(jobId: string, workerId: string, error: string, retryAt?: number): Promise<void> {
    this.db
      .prepare(
        `UPDATE agent_jobs SET last_error = ?, lease_owner = NULL, lease_until = NULL,
           status = CASE WHEN ? IS NULL OR attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
           available_at = COALESCE(?, available_at)
         WHERE id = ? AND lease_owner = ?`,
      )
      .run(error, retryAt ?? null, retryAt ?? null, jobId, workerId);
  }
  async get(jobId: string): Promise<Job | undefined> {
    const row = this.db.prepare(`SELECT * FROM agent_jobs WHERE id = ?`).get(jobId) as Row | undefined;
    return row === undefined ? undefined : fromRow(row);
  }
}
