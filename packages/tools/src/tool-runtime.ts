import { createHash } from "node:crypto";
import {
  ApprovalExpiredError,
  ApprovalRejectedError,
  CancellationError,
  FrameworkError,
  RateLimitError,
  ToolAuthorizationError,
  ToolError,
  ToolTimeoutError,
  ValidationError,
  noopEmit,
  raceAbort,
  randomIds,
  sleep,
  systemClock,
  type AgentIdentity,
  type ApprovalDecision,
  type ApprovalRequest,
  type Clock,
  type EmitFn,
  type EventCorrelation,
  type IdGenerator,
  type Principal,
  type SerializedError,
  type ToolInvocation,
  type ToolInvocationResult,
  type ToolInvoker,
} from "@agent-farmework/core";
import { z } from "zod";
import { permissionPolicy, type ToolAuthorizationDecision, type ToolPolicy } from "./policy.js";
import {
  InMemoryAuditLog,
  InMemoryIdempotencyStore,
  InMemoryRateLimiter,
  Semaphore,
  type AuditSink,
  type IdempotencyStore,
  type RateLimiter,
  type ToolAuditRecord,
} from "./stores.js";
import { isTool, type AnyTool, type Tool, type ToolConfig, type ToolContext } from "./tool.js";

export interface ToolRuntimeOptions {
  /** Deterministic authorization. Default: `permissionPolicy()`. */
  policy?: ToolPolicy;
  /** Default: bounded in-memory audit log (see `ToolRuntime.audit`). */
  audit?: AuditSink;
  idempotency?: IdempotencyStore;
  rateLimiter?: RateLimiter;
  /** Per-attempt timeout for tools that do not set one. Default 30 000 ms. */
  defaultTimeoutMs?: number;
  clock?: Clock;
  ids?: IdGenerator;
  /** Called when the audit sink throws. */
  onAuditError?: (error: unknown, record: ToolAuditRecord) => void;
}

export interface ExecuteToolOptions {
  agent: AgentIdentity;
  user?: Principal;
  runId?: string;
  toolCallId?: string;
  signal?: AbortSignal;
  emit?: EmitFn;
  approval?: { request: ApprovalRequest; decision: ApprovalDecision };
}

export type ToolExecutionResult<TOutput> = Omit<ToolInvocationResult, "output"> & { output?: TOutput };

type AttemptOutcome = { ok: true; output: unknown } | { ok: false; error: FrameworkError; timedOut: boolean; detail?: string };

interface Outcome {
  status: ToolInvocationResult["status"];
  output?: unknown;
  error?: FrameworkError;
  errorDetail?: string;
  approval?: ApprovalRequest;
  attempts?: number;
  cached?: boolean;
}

/**
 * The only path from a model's tool request to `execute`:
 *
 *   parse → validate input → authorize → approval → rate limit →
 *   idempotency → concurrency → execute (timeout, retry) → validate output → audit
 *
 * `invoke` never throws for tool-level problems; it returns a normalized result.
 */
export class ToolRuntime implements ToolInvoker {
  readonly audit: AuditSink;
  private readonly policy: ToolPolicy;
  private readonly idempotency: IdempotencyStore;
  private readonly rateLimiter: RateLimiter;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly semaphores = new Map<string, Semaphore>();
  private readonly inFlight = new Map<string, Promise<AttemptOutcome>>();

  constructor(private readonly options: ToolRuntimeOptions = {}) {
    this.policy = options.policy ?? permissionPolicy();
    this.audit = options.audit ?? new InMemoryAuditLog();
    this.clock = options.clock ?? systemClock;
    this.ids = options.ids ?? randomIds;
    const now = (): number => this.clock.now().getTime();
    this.idempotency = options.idempotency ?? new InMemoryIdempotencyStore(now);
    this.rateLimiter = options.rateLimiter ?? new InMemoryRateLimiter(now);
  }

  /** Execute a tool directly from application code, through the same pipeline a model uses. */
  async execute<TInput, TOutput>(tool: Tool<TInput, TOutput>, input: unknown, options: ExecuteToolOptions): Promise<ToolExecutionResult<TOutput>> {
    const result = await this.invoke({
      tool,
      toolCallId: options.toolCallId ?? this.ids.next("tool"),
      rawArguments: input,
      runId: options.runId ?? "direct",
      identity: { agent: options.agent, ...(options.user === undefined ? {} : { user: options.user }) },
      signal: options.signal ?? new AbortController().signal,
      emit: options.emit ?? noopEmit,
      ...(options.approval === undefined ? {} : { approval: options.approval }),
    });
    return result as ToolExecutionResult<TOutput>;
  }

  async invoke(invocation: ToolInvocation): Promise<ToolInvocationResult> {
    const startedAt = Date.now();
    const audit: Partial<ToolAuditRecord> = {};
    let outcome: Outcome;
    try {
      outcome = await this.pipeline(invocation, audit);
    } catch (error) {
      const cancelled = invocation.signal.aborted;
      outcome = {
        status: "error",
        error: cancelled
          ? FrameworkError.from(invocation.signal.reason, (m) => new CancellationError(m))
          : FrameworkError.from(error, (_m, cause) => new ToolError("Tool invocation failed unexpectedly", { cause })),
      };
    }

    const serialized = outcome.error === undefined ? undefined : this.serialize(outcome.error, invocation);
    const result: ToolInvocationResult = {
      status: outcome.status,
      attempts: outcome.attempts ?? 0,
      durationMs: Date.now() - startedAt,
      cached: outcome.cached ?? false,
      ...(outcome.status === "success" ? { output: outcome.output } : {}),
      ...(serialized === undefined ? {} : { error: serialized }),
      ...(outcome.approval === undefined ? {} : { approval: outcome.approval }),
    };
    await this.recordAudit(invocation, result, audit, outcome.errorDetail);
    return result;
  }

  // ------------------------------------------------------------------ pipeline

  private async pipeline(inv: ToolInvocation, audit: Partial<ToolAuditRecord>): Promise<Outcome> {
    const correlation: EventCorrelation = {
      toolCallId: inv.toolCallId,
      ...(inv.stepId === undefined ? {} : { stepId: inv.stepId }),
      ...(inv.llmCallId === undefined ? {} : { llmCallId: inv.llmCallId }),
    };
    const emit: EmitFn = (type, payload, extra) => inv.emit(type, payload, extra ?? correlation);
    const toolName = inv.tool.name;
    const ids = { toolCallId: inv.toolCallId, toolName };

    // 1. Only tools built with defineTool() can execute. A hand-made object cannot smuggle in an execute function.
    if (!isTool(inv.tool)) {
      const decision = { allowed: false, policy: "tool-runtime", reason: "Not a framework tool (use defineTool)" };
      audit.authorization = decision;
      inv.emit("TOOL_AUTHORIZATION_COMPLETED", { ...ids, ...decision }, correlation);
      return { status: "denied", error: new ToolAuthorizationError("Tool call was not authorized") };
    }
    const tool: AnyTool = inv.tool;
    const def = tool.definition as ToolConfig<unknown, unknown>;

    // 2. Parse and validate model-generated arguments. Invalid arguments never execute.
    let raw: unknown = inv.rawArguments;
    if (typeof raw === "string") {
      try {
        raw = raw.trim() === "" ? {} : JSON.parse(raw);
      } catch {
        return { status: "error", error: new ValidationError(`Arguments for tool '${toolName}' are not valid JSON`) };
      }
    }
    const parsed = def.input.safeParse(raw);
    if (!parsed.success) {
      return {
        status: "error",
        error: new ValidationError(`Invalid arguments for tool '${toolName}': ${z.prettifyError(parsed.error)}`),
      };
    }
    const input = parsed.data;
    audit.input = def.sensitive === true ? "[REDACTED]" : input;
    const user = inv.identity.user;

    // 3. Deterministic authorization: agent identity + user identity + tenant + tool permissions.
    inv.emit("TOOL_AUTHORIZATION_STARTED", ids, correlation);
    let decision: ToolAuthorizationDecision;
    try {
      decision = await this.policy.authorize({
        tool: { name: toolName, version: tool.version, kind: tool.kind, permissions: def.permissions ?? [], metadata: def.metadata ?? {} },
        input,
        agent: inv.identity.agent,
        ...(user === undefined ? {} : { user }),
        runId: inv.runId,
        toolCallId: inv.toolCallId,
      });
    } catch (error) {
      decision = { allowed: false, policy: this.policy.name, reason: `Policy evaluation failed: ${String(error)}` };
    }
    decision = { allowed: decision.allowed === true, policy: decision.policy, reason: decision.reason };
    audit.authorization = decision;
    inv.emit("TOOL_AUTHORIZATION_COMPLETED", { ...ids, ...decision }, correlation);
    if (!decision.allowed) {
      return { status: "denied", error: new ToolAuthorizationError("Tool call was not authorized") };
    }

    // 4. Human approval. Approval is bound to the tool call and the exact validated arguments.
    const argumentsHash = hashArguments(input);
    if (inv.approval !== undefined) {
      const { request, decision: human } = inv.approval;
      const bound =
        request.toolCallId === inv.toolCallId &&
        request.toolName === toolName &&
        // A reviewer-modified call carries new arguments by design; they were validated and authorized above.
        (human.decision === "modified" || request.argumentsHash === argumentsHash) &&
        human.decision !== "escalated" &&
        human.approvalId === request.approvalId;
      if (!bound) {
        return {
          status: "denied",
          error: new ToolAuthorizationError("Approval does not match this tool call", { metadata: { reason: "APPROVAL_MISMATCH" } }),
        };
      }
      if (request.expiresAt !== undefined && this.clock.now().getTime() > Date.parse(request.expiresAt)) {
        return { status: "denied", error: new ApprovalExpiredError(`Approval '${request.approvalId}' has expired`) };
      }
      const decidedBy = human.decidedBy === undefined ? {} : { decidedBy: human.decidedBy };
      if (human.decision === "rejected") {
        audit.approval = { approvalId: request.approvalId, decision: "rejected", ...decidedBy };
        inv.emit("TOOL_APPROVAL_REJECTED", { ...ids, approvalId: request.approvalId, ...decidedBy, ...(human.reason === undefined ? {} : { reason: human.reason }) }, correlation);
        return {
          status: "rejected",
          error: new ApprovalRejectedError(`The reviewer rejected this action${human.reason === undefined ? "" : `: ${human.reason}`}`),
        };
      }
      const modified = human.decision === "modified";
      audit.approval = { approvalId: request.approvalId, decision: modified ? "modified" : "approved", ...decidedBy };
      inv.emit("TOOL_APPROVAL_GRANTED", { ...ids, approvalId: request.approvalId, ...decidedBy, ...(modified ? { modified } : {}) }, correlation);
    } else if (this.approvalRequired(def, input, user)) {
      const now = this.clock.now();
      const approval: ApprovalRequest = {
        approvalId: this.ids.next("approval"),
        toolCallId: inv.toolCallId,
        toolName,
        argumentsHash,
        requestedAt: now.toISOString(),
        ...(def.approval?.expiresInMs === undefined ? {} : { expiresAt: new Date(now.getTime() + def.approval.expiresInMs).toISOString() }),
        ...(def.approval?.reason === undefined ? {} : { reason: def.approval.reason }),
      };
      audit.approval = { approvalId: approval.approvalId, decision: "requested" };
      inv.emit(
        "TOOL_APPROVAL_REQUIRED",
        { ...ids, approvalId: approval.approvalId, ...(approval.expiresAt === undefined ? {} : { expiresAt: approval.expiresAt }) },
        correlation,
      );
      return { status: "approval_required", approval };
    }

    // 5. Rate limiting (not executed when exceeded).
    if (def.rateLimit !== undefined) {
      const scope = def.rateLimit.scope ?? "global";
      const bucket = scope === "tenant" ? (user?.tenantId ?? "-") : scope === "user" ? (user?.userId ?? "-") : "*";
      const ok = await this.rateLimiter.tryAcquire(`${toolName}:${scope}:${bucket}`, def.rateLimit.maxCalls, def.rateLimit.windowMs);
      if (!ok) return { status: "error", error: new RateLimitError(`Rate limit exceeded for tool '${toolName}'`) };
    }

    // 6. Idempotency: a stored success is returned instead of executing again.
    let idempotencyKey: string | undefined;
    if (def.idempotency !== undefined) {
      idempotencyKey = `${toolName}:${user?.tenantId ?? "-"}:${def.idempotency.key(input, { runId: inv.runId, ...(user === undefined ? {} : { user }) })}`;
      const stored = await this.idempotency.get(idempotencyKey);
      if (stored !== undefined) {
        emit("TOOL_EXECUTION_COMPLETED", { ...ids, attempts: 0, durationMs: 0, cached: true });
        return { status: "success", output: stored.output, cached: true };
      }
      const running = this.inFlight.get(idempotencyKey);
      if (running !== undefined) {
        const shared = await running;
        if (shared.ok) {
          emit("TOOL_EXECUTION_COMPLETED", { ...ids, attempts: 0, durationMs: 0, cached: true });
          return { status: "success", output: shared.output, cached: true };
        }
      }
    }

    // 7–9. Concurrency, execution with timeout and retry, output validation.
    let attempts = 0;
    const run = async (): Promise<AttemptOutcome> => {
      const release = def.concurrency === undefined ? undefined : await this.semaphore(toolName, def.concurrency).acquire(inv.signal);
      try {
        const retry = def.retry;
        const maxAttempts = retry?.maxAttempts ?? 1;
        const timeoutMs = def.timeoutMs ?? this.options.defaultTimeoutMs ?? 30_000;
        for (;;) {
          attempts += 1;
          emit("TOOL_EXECUTION_STARTED", { ...ids, attempt: attempts });
          const outcome = await this.attempt(def, input, inv, attempts, timeoutMs);
          if (outcome.ok) return outcome;
          const retryable = outcome.error.retryable || (outcome.timedOut && retry?.retryOnTimeout === true);
          const willRetry = retryable && attempts < maxAttempts;
          if (outcome.timedOut) {
            emit("TOOL_EXECUTION_TIMED_OUT", { ...ids, attempt: attempts, willRetry, timeoutMs });
          } else {
            emit("TOOL_EXECUTION_FAILED", { ...ids, attempt: attempts, willRetry, error: this.serialize(outcome.error, inv) });
          }
          if (!willRetry) return outcome;
          const initial = retry?.initialDelayMs ?? 100;
          const delay = retry?.backoff === "exponential" ? initial * 2 ** (attempts - 1) : initial;
          await sleep(Math.min(delay, retry?.maxDelayMs ?? 10_000), inv.signal);
        }
      } finally {
        release?.();
      }
    };

    const startedAt = Date.now();
    const pending = run();
    if (idempotencyKey !== undefined) this.inFlight.set(idempotencyKey, pending);
    let outcome: AttemptOutcome;
    try {
      outcome = await pending;
    } finally {
      if (idempotencyKey !== undefined) this.inFlight.delete(idempotencyKey);
    }

    if (!outcome.ok) {
      return { status: "error", error: outcome.error, attempts, ...(outcome.detail === undefined ? {} : { errorDetail: outcome.detail }) };
    }
    if (idempotencyKey !== undefined) {
      await this.idempotency.set(idempotencyKey, { output: outcome.output }, def.idempotency?.ttlMs);
    }
    emit("TOOL_EXECUTION_COMPLETED", { ...ids, attempts, durationMs: Date.now() - startedAt, cached: false });
    return { status: "success", output: outcome.output, attempts };
  }

  private async attempt(
    def: ToolConfig<unknown, unknown>,
    input: unknown,
    inv: ToolInvocation,
    attempt: number,
    timeoutMs: number,
  ): Promise<AttemptOutcome> {
    const controller = new AbortController();
    const onParentAbort = (): void => controller.abort(inv.signal.reason);
    if (inv.signal.aborted) onParentAbort();
    else inv.signal.addEventListener("abort", onParentAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new ToolTimeoutError(`Tool '${def.name}' timed out after ${timeoutMs}ms`, { toolCallId: inv.toolCallId })),
      timeoutMs,
    );
    const context: ToolContext = {
      runId: inv.runId,
      toolCallId: inv.toolCallId,
      agentId: inv.identity.agent.agentId,
      ...(inv.stepId === undefined ? {} : { stepId: inv.stepId }),
      ...(inv.identity.user === undefined ? {} : { user: inv.identity.user }),
      signal: controller.signal,
      attempt,
    };
    try {
      // raceAbort enforces the timeout even when the tool ignores its signal.
      const output = await raceAbort(Promise.resolve().then(() => def.execute(input, context)), controller.signal);
      if (def.output !== undefined) {
        const checked = def.output.safeParse(output);
        if (!checked.success) {
          return {
            ok: false,
            timedOut: false,
            error: new FrameworkError("TOOL_OUTPUT_INVALID", "tool", `Tool '${def.name}' returned output that failed validation`),
            detail: z.prettifyError(checked.error),
          };
        }
        return { ok: true, output: checked.data };
      }
      return { ok: true, output };
    } catch (error) {
      if (inv.signal.aborted) throw error; // run cancellation / run timeout: propagate, never retry
      if (controller.signal.aborted && controller.signal.reason instanceof ToolTimeoutError) {
        return { ok: false, timedOut: true, error: controller.signal.reason };
      }
      if (error instanceof FrameworkError) return { ok: false, timedOut: false, error };
      // Raw exception messages may contain internals; keep them out of the model context.
      return {
        ok: false,
        timedOut: false,
        error: new ToolError(`Tool '${def.name}' failed`, { cause: error, retryable: false }),
        detail: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
      inv.signal.removeEventListener("abort", onParentAbort);
    }
  }

  // ------------------------------------------------------------------ helpers

  private approvalRequired(def: ToolConfig<unknown, unknown>, input: unknown, user: Principal | undefined): boolean {
    const required = def.approval?.required;
    if (required === undefined) return false;
    if (typeof required === "boolean") return required;
    try {
      return required(input, user === undefined ? {} : { user });
    } catch {
      return true; // fail safe: an approval predicate that throws requires approval
    }
  }

  private semaphore(toolName: string, capacity: number): Semaphore {
    let semaphore = this.semaphores.get(toolName);
    if (semaphore === undefined) {
      semaphore = new Semaphore(capacity);
      this.semaphores.set(toolName, semaphore);
    }
    return semaphore;
  }

  private serialize(error: FrameworkError, inv: ToolInvocation): SerializedError {
    return { ...error.toJSON(), runId: inv.runId, toolCallId: inv.toolCallId, ...(inv.stepId === undefined ? {} : { stepId: inv.stepId }) };
  }

  private async recordAudit(
    inv: ToolInvocation,
    result: ToolInvocationResult,
    partial: Partial<ToolAuditRecord>,
    errorDetail: string | undefined,
  ): Promise<void> {
    const user = inv.identity.user;
    const tool = isTool(inv.tool) ? inv.tool : undefined;
    const record: ToolAuditRecord = {
      auditId: this.ids.next("tool"),
      recordedAt: this.clock.now().toISOString(),
      runId: inv.runId,
      toolCallId: inv.toolCallId,
      agentId: inv.identity.agent.agentId,
      ...(user === undefined ? {} : { userId: user.userId }),
      ...(user?.tenantId === undefined ? {} : { tenantId: user.tenantId }),
      toolName: inv.tool.name,
      ...(tool?.version === undefined ? {} : { toolVersion: tool.version }),
      toolKind: tool?.kind ?? "unknown",
      outcome: result.status,
      ...partial,
      attempts: result.attempts,
      durationMs: result.durationMs,
      cached: result.cached,
      ...(result.error === undefined
        ? {}
        : { error: errorDetail === undefined ? result.error : { ...result.error, metadata: { ...result.error.metadata, detail: errorDetail } } }),
    };
    try {
      await this.audit.record(record);
    } catch (error) {
      this.options.onAuditError?.(error, record);
    }
  }
}

/** SHA-256 over a canonical (key-sorted) JSON encoding of the validated arguments. */
export function hashArguments(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
