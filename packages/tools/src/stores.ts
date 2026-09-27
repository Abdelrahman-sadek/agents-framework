import type { SerializedError } from "@agent-farmework/core";
import type { ToolInvocationStatus } from "@agent-farmework/core";

// ------------------------------------------------------------------ audit

export interface ToolAuditRecord {
  auditId: string;
  recordedAt: string;
  runId: string;
  toolCallId: string;
  agentId: string;
  userId?: string;
  tenantId?: string;
  toolName: string;
  toolVersion?: string;
  toolKind: string;
  outcome: ToolInvocationStatus;
  authorization?: { allowed: boolean; policy: string; reason: string };
  approval?: { approvalId: string; decision: "requested" | "approved" | "modified" | "rejected"; decidedBy?: string };
  /** Validated input, or "[REDACTED]" for sensitive tools. Absent when the input never validated. */
  input?: unknown;
  attempts: number;
  durationMs: number;
  cached: boolean;
  error?: SerializedError;
}

/** Append-only audit sink. Production adapters write to PostgreSQL, a SIEM, etc. */
export interface AuditSink {
  record(entry: ToolAuditRecord): void | Promise<void>;
}

/** Bounded in-memory audit log for development and tests. */
export class InMemoryAuditLog implements AuditSink {
  readonly entries: ToolAuditRecord[] = [];
  constructor(private readonly maxEntries = 10_000) {}
  record(entry: ToolAuditRecord): void {
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) this.entries.shift();
  }
}

// ------------------------------------------------------------------ idempotency

export interface IdempotencyStore {
  get(key: string): Promise<{ output: unknown } | undefined>;
  set(key: string, value: { output: unknown }, ttlMs: number | undefined): Promise<void>;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, { output: unknown; expiresAt: number | undefined }>();
  constructor(private readonly now: () => number = Date.now) {}

  async get(key: string): Promise<{ output: unknown } | undefined> {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt !== undefined && this.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return { output: entry.output };
  }

  async set(key: string, value: { output: unknown }, ttlMs: number | undefined): Promise<void> {
    this.entries.set(key, { output: value.output, expiresAt: ttlMs === undefined ? undefined : this.now() + ttlMs });
  }
}

// ------------------------------------------------------------------ rate limiting

export interface RateLimiter {
  /** Consume one unit from `key`. Returns false when the window is exhausted. */
  tryAcquire(key: string, maxCalls: number, windowMs: number): Promise<boolean>;
}

/** Fixed-window limiter, process-local. Use a Redis adapter for multi-instance deployments. */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  async tryAcquire(key: string, maxCalls: number, windowMs: number): Promise<boolean> {
    const now = this.now();
    const current = this.windows.get(key);
    if (current === undefined || now - current.start >= windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    if (current.count >= maxCalls) return false;
    current.count += 1;
    return true;
  }
}

// ------------------------------------------------------------------ concurrency

export class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(private readonly capacity: number) {}

  async acquire(signal: AbortSignal): Promise<() => void> {
    if (this.active < this.capacity) {
      this.active += 1;
      return () => this.release();
    }
    return new Promise((resolve, reject) => {
      const grant = (): void => {
        signal.removeEventListener("abort", onAbort);
        this.active += 1;
        resolve(() => this.release());
      };
      const onAbort = (): void => {
        const index = this.waiters.indexOf(grant);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      };
      this.waiters.push(grant);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }
}
