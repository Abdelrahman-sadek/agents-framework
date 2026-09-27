import { ValidationError, randomIds, type AgentRuntime, type ApprovalDecision, type ApprovalRequest, type IdGenerator, type Principal, type SerializedError, type UsageTotals } from "@agent-farmework/core";
import type { JobQueue } from "./queue.js";

export interface RunStatus {
  runId: string;
  agentId: string;
  status: string;
  output?: unknown;
  error?: SerializedError;
  pendingApprovals: ApprovalRequest[];
  usage: UsageTotals;
  updatedAt: string;
}

/**
 * API-facing service: API → create run → queue → worker → persistent state.
 * Long-running work never depends on an HTTP request staying open.
 */
export class AgentService {
  private readonly ids: IdGenerator;
  constructor(private readonly options: { queue: JobQueue; runtime: AgentRuntime; agents: readonly string[]; ids?: IdGenerator; maxAttempts?: number }) {
    this.ids = options.ids ?? randomIds;
  }

  /** Enqueue a run. With a caller-supplied `runId` (idempotency key), repeated submits are deduplicated. */
  async submit(agent: string, request: { input: unknown; user?: Principal; metadata?: Record<string, unknown>; runId?: string }): Promise<{ runId: string; jobId: string; deduplicated: boolean }> {
    if (!this.options.agents.includes(agent)) throw new ValidationError(`Unknown agent '${agent}'`);
    if (request.input === undefined) throw new ValidationError("input is required");
    const runId = request.runId ?? this.ids.next("run");
    const jobId = `run:${runId}`;
    const existing = (await this.options.queue.get(jobId)) ?? (await this.options.runtime.getState(runId));
    if (existing !== undefined) return { runId, jobId, deduplicated: true };
    await this.options.queue.enqueue({
      id: jobId,
      agent,
      runId,
      ...(this.options.maxAttempts === undefined ? {} : { maxAttempts: this.options.maxAttempts }),
      payload: { kind: "run", input: request.input, ...(request.user === undefined ? {} : { user: request.user }), ...(request.metadata === undefined ? {} : { metadata: request.metadata }) },
    });
    return { runId, jobId, deduplicated: false };
  }

  /** Record human decisions and enqueue the resume. */
  async approve(runId: string, approvals: readonly ApprovalDecision[]): Promise<{ jobId: string }> {
    const state = await this.options.runtime.getState(runId);
    if (state === undefined) throw new ValidationError(`Run '${runId}' not found`);
    if (state.status !== "WAITING_FOR_APPROVAL") throw new ValidationError(`Run '${runId}' is ${state.status}`);
    const pending = new Set(state.pendingApprovals.map((p) => p.approval.approvalId));
    const unknown = approvals.filter((a) => !pending.has(a.approvalId));
    if (unknown.length > 0) throw new ValidationError(`Approvals not pending: ${unknown.map((a) => a.approvalId).join(", ")}`);
    const jobId = `resume:${runId}:${approvals.map((a) => a.approvalId).sort().join(",")}`;
    await this.options.queue.enqueue({ id: jobId, agent: state.agentId, runId, payload: { kind: "resume", approvals: [...approvals] } });
    return { jobId };
  }

  async status(runId: string): Promise<RunStatus | undefined> {
    const state = await this.options.runtime.getState(runId);
    if (state === undefined) {
      const job = await this.options.queue.get(`run:${runId}`);
      return job === undefined
        ? undefined
        : { runId, agentId: job.agent, status: job.status === "failed" ? "FAILED" : "QUEUED", pendingApprovals: [], usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0, estimatedCostUsd: 0, llmCalls: 0, toolCalls: 0 }, updatedAt: new Date(job.availableAt).toISOString() };
    }
    return {
      runId,
      agentId: state.agentId,
      status: state.status,
      ...(state.status === "COMPLETED" ? { output: state.output } : {}),
      ...(state.error === undefined ? {} : { error: state.error }),
      pendingApprovals: state.pendingApprovals.map((p) => p.approval),
      usage: state.usage,
      updatedAt: state.updatedAt,
    };
  }
}
