import { FrameworkError, randomIds, type Agent, type AgentRuntime, type IdGenerator } from "@agent-farmework/core";
import type { Job, JobQueue } from "./queue.js";

export interface AgentWorkerOptions {
  queue: JobQueue;
  runtime: AgentRuntime;
  agents: readonly Agent<unknown>[];
  workerId?: string;
  /** Jobs processed concurrently. Default 2. */
  concurrency?: number;
  /** Lease length; renewed by heartbeat every third of it. Default 60 s. */
  leaseMs?: number;
  pollIntervalMs?: number;
  /** Base delay before a job that threw is retried (exponential). Default 1 s. */
  retryDelayMs?: number;
  onError?: (error: unknown, job: Job) => void;
  ids?: IdGenerator;
}

export type JobOutcome = "ran" | "resumed" | "recovered" | "duplicate" | "retry" | "failed";

/**
 * Pulls jobs from a durable queue and drives runs to their next stable state.
 * Delivery is at-least-once; the run state makes processing idempotent:
 *
 * - new run → `run()`; state RUNNING (previous worker died) → `recover()`
 * - resume job → `resume()` when waiting, `recover()` when RUNNING
 * - anything already terminal or waiting → acknowledged as a duplicate
 */
export class AgentWorker {
  readonly workerId: string;
  private readonly agents: Map<string, Agent<unknown>>;
  private readonly inFlight = new Set<Promise<unknown>>();
  private running = false;
  private loops: Promise<void>[] = [];

  constructor(private readonly options: AgentWorkerOptions) {
    this.workerId = options.workerId ?? (options.ids ?? randomIds).next("worker");
    this.agents = new Map(options.agents.map((a) => [a.id, a]));
  }

  /** Start polling. */
  start(): void {
    if (this.running) return;
    this.running = true;
    const concurrency = this.options.concurrency ?? 2;
    this.loops = Array.from({ length: concurrency }, async () => {
      while (this.running) {
        const processed = await this.processNext().catch(() => false);
        if (!processed) await new Promise((r) => setTimeout(r, this.options.pollIntervalMs ?? 250));
      }
    });
  }

  /**
   * Graceful shutdown: stop leasing, wait for in-flight jobs up to `timeoutMs`.
   * Jobs still running after that keep their state; their leases expire and
   * another worker recovers them. Returns the number of jobs left running.
   */
  async stop(options: { timeoutMs?: number } = {}): Promise<number> {
    this.running = false;
    const all = Promise.allSettled([...this.inFlight, ...this.loops]);
    await Promise.race([all, new Promise((r) => setTimeout(r, options.timeoutMs ?? 30_000))]);
    return this.inFlight.size;
  }

  /** Lease and process one job. Returns false when the queue was empty. */
  async processNext(): Promise<JobOutcome | false> {
    const leaseMs = this.options.leaseMs ?? 60_000;
    const job = await this.options.queue.lease(this.workerId, leaseMs);
    if (job === undefined) return false;
    const work = this.process(job, leaseMs);
    this.inFlight.add(work);
    try {
      return await work;
    } finally {
      this.inFlight.delete(work);
    }
  }

  private async process(job: Job, leaseMs: number): Promise<JobOutcome> {
    const { queue, runtime } = this.options;
    const agent = this.agents.get(job.agent);
    if (agent === undefined) {
      await queue.fail(job.id, this.workerId, `Unknown agent '${job.agent}'`);
      return "failed";
    }
    const heartbeat = setInterval(() => void queue.heartbeat(job.id, this.workerId, leaseMs), Math.max(1000, leaseMs / 3));
    try {
      const state = await runtime.getState(job.runId);
      let outcome: JobOutcome;
      if (state?.status === "RUNNING") {
        await runtime.recover(agent, { runId: job.runId });
        outcome = "recovered";
      } else if (job.payload.kind === "run" && state === undefined) {
        const p = job.payload;
        await runtime.run(agent, {
          input: p.input,
          runId: job.runId,
          ...(p.user === undefined ? {} : { user: p.user }),
          ...(p.metadata === undefined ? {} : { metadata: p.metadata }),
        });
        outcome = "ran";
      } else if (job.payload.kind === "resume" && state?.status === "WAITING_FOR_APPROVAL") {
        const pending = new Set(state.pendingApprovals.map((a) => a.approval.approvalId));
        const approvals = job.payload.approvals.filter((a) => pending.has(a.approvalId));
        if (approvals.length === 0) outcome = "duplicate";
        else {
          await runtime.resume(agent, { runId: job.runId, approvals });
          outcome = "resumed";
        }
      } else {
        outcome = "duplicate";
      }
      await queue.complete(job.id, this.workerId);
      return outcome;
    } catch (error) {
      // Infrastructure problems (state store down, …): retry with backoff.
      this.options.onError?.(error, job);
      const retryable = !(error instanceof FrameworkError) || error.retryable || error.category === "infrastructure";
      const delay = (this.options.retryDelayMs ?? 1000) * 2 ** (job.attempts - 1);
      await queue.fail(job.id, this.workerId, error instanceof Error ? error.message : String(error), retryable ? Date.now() + delay : undefined);
      return retryable && job.attempts < job.maxAttempts ? "retry" : "failed";
    } finally {
      clearInterval(heartbeat);
    }
  }
}
