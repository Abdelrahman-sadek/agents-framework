import { BaseFrameworkError, ToolError, ToolAuthorizationError } from "@agent-framework/core";
import { Tool, ToolExecutionContext, ToolCallRequest, ToolAuthorizationContext, ToolAuthorizationResult, ToolResult, ToolObservation, ToolAuditEntry, ValidatedToolInput, ToolRetryConfig, PolicyEngine, AuditStore, ObservationEmitter, IdempotencyStore } from "./tool-definition.js";

export class DefaultPolicyEngine implements PolicyEngine {
  async authorize(context: ToolAuthorizationContext): Promise<ToolAuthorizationResult> {
    const tool = context.toolName;
    const permissions = context.permissions ?? context.metadata?.permissions;

    if (!permissions) {
      return { allowed: true, authorizedBy: "default-policy", permissionScope: [] };
    }

    if (permissions.denied && permissions.denied.includes(tool)) {
      return { allowed: false, reason: `Tool '${tool}' is denied by policy`, authorizedBy: "default-policy" };
    }

    if (!permissions.allowed || !permissions.allowed.includes(tool)) {
      return { allowed: false, reason: `Tool '${tool}' is not in allowed list`, authorizedBy: "default-policy" };
    }

    return { allowed: true, authorizedBy: "default-policy", permissionScope: permissions.dataScope };
  }
}

export class InMemoryAuditStore implements AuditStore {
  private entries: ToolAuditEntry[] = [];
  async record(entry: ToolAuditEntry): Promise<void> {
    this.entries.push(entry);
  }
  getEntries(): ToolAuditEntry[] {
    return this.entries;
  }
}

export class InMemoryObservationEmitter implements ObservationEmitter {
  private observations: ToolObservation[] = [];
  async emit(observation: ToolObservation): Promise<void> {
    this.observations.push(observation);
  }
  getObservations(): ToolObservation[] {
    return this.observations;
  }
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private store = new Map<string, { result: ToolResult<unknown>; expiresAt?: number }>();
  async check(key: string): Promise<{ exists: boolean; result?: ToolResult<unknown> }> {
    const entry = this.store.get(key);
    if (!entry) return { exists: false };
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return { exists: false };
    }
    return { exists: true, result: entry.result };
  }
  async set(key: string, result: ToolResult<unknown>, ttlMs?: number): Promise<void> {
    this.store.set(key, { result, expiresAt: ttlMs ? Date.now() + ttlMs : undefined });
  }
}

export class ToolRuntime {
  constructor(
    public readonly policyEngine: PolicyEngine = new DefaultPolicyEngine(),
    public readonly auditStore: AuditStore = new InMemoryAuditStore(),
    public readonly observationEmitter: ObservationEmitter = new InMemoryObservationEmitter(),
    public readonly idempotencyStore: IdempotencyStore = new InMemoryIdempotencyStore(),
  ) {}

  async execute<TInput, TOutput>(
    request: ToolCallRequest<TInput>,
    runConfig?: { signal?: AbortSignal; toolCallId?: string },
  ): Promise<ToolResult<TOutput>> {
    const toolCallId = runConfig?.toolCallId ?? crypto.randomUUID();
    const context: ToolExecutionContext = {
      runId: request.runId,
      agentId: request.agentId,
      userId: request.userId,
      tenantId: request.tenantId,
      organizationId: request.organizationId,
      toolCallId,
      stepId: request.stepId,
      metadata: request.tool.metadata,
      signal: runConfig?.signal ?? request.tool.metadata?.signal,
    };

    const startedAt = Date.now();
    const observation: ToolObservation = {
      toolCallId,
      runId: request.runId,
      agentId: request.agentId,
      toolName: request.tool.name,
      toolVersion: request.tool.version,
      input: request.input,
      status: "PENDING",
      startedAt: new Date().toISOString(),
    };

    try {
      const validatedInput = validateInput(request.tool, request.input);
      if (!validatedInput.ok) {
        observation.status = "FAILED";
        observation.completedAt = new Date().toISOString();
        observation.error = validatedInput.error;
        await this.emitObservation(observation);
        await this.audit(observation, false, validatedInput.error.message);
        return { ok: false, error: validatedInput.error };
      }

      const authContext: ToolAuthorizationContext = {
        ...context,
        toolName: request.tool.name,
        toolVersion: request.tool.version,
        input: request.input,
        requestedAction: request.tool.metadata?.requestedAction,
        permissions: request.tool.permissions,
      };

      const authResult = await this.policyEngine.authorize(authContext);
      if (!authResult.allowed) {
        observation.status = "REJECTED";
        observation.completedAt = new Date().toISOString();
        observation.error = { code: "TOOL_AUTHORIZATION_ERROR", message: authResult.reason ?? "Not authorized" };
        await this.emitObservation(observation);
        await this.audit(observation, false, authResult.reason ?? "Not authorized");
        return { ok: false, error: observation.error };
      }

      if (authResult.requiredApproval) {
        observation.status = "APPROVAL_REQUIRED";
        observation.approvalId = authResult.approvalId;
        await this.emitObservation(observation);
        return { ok: false, error: { code: "APPROVAL_REQUIRED_ERROR", message: "Tool execution requires approval" } };
      }

      observation.status = "RUNNING";
      observation.permissionScope = authResult.permissionScope;
      observation.authorizedBy = authResult.authorizedBy;

      const result = await this.executeWithReliability(request.tool, validatedInput.value, context, observation);

      observation.status = result.ok ? "COMPLETED" : "FAILED";
      observation.output = result.ok ? result.output : undefined;
      observation.error = result.error;
      observation.completedAt = new Date().toISOString();
      observation.durationMs = Date.now() - startedAt;

      if (observation.durationMs) {
        observation.metadata = { durationMs: observation.durationMs };
      }

      await this.emitObservation(observation);
      await this.audit(observation, result.ok, result.error?.message);

      return result;
    } catch (err) {
      const error = err instanceof BaseFrameworkError ? err : new ToolError(String(err), { cause: err, runId: request.runId, toolCallId });
      observation.status = "FAILED";
      observation.error = { code: error.code, message: error.message };
      observation.completedAt = new Date().toISOString();
      observation.durationMs = Date.now() - startedAt;
      await this.emitObservation(observation);
      await this.audit(observation, false, error.message);
      return { ok: false, error: { code: error.code, message: error.message } };
    }
  }

  private async executeWithReliability<TInput, TOutput>(
    tool: Tool<TInput, TOutput>,
    input: TInput,
    context: ToolExecutionContext,
    observation: ToolObservation,
  ): Promise<ToolResult<TOutput>> {
    const timeoutMs = tool.timeoutMs ?? 30000;
    const retryConfig = tool.retry;

    let attempt = 0;
    let lastError: ToolResult<TOutput> | undefined;

    const runWithTimeout = async (): Promise<ToolResult<TOutput>> => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        try { controller.abort(new Error("Tool execution timed out")); } catch {}
      }, timeoutMs);

      // Forward external caller cancellation into the internal controller so that
      // Agent.cancel() (or any external AbortSignal) visibly aborts this controller
      // and is treated as a cancellation/timeout, not a generic tool error.
      if (context.signal) {
        if (context.signal.aborted) {
          controller.abort(context.signal.reason);
        } else {
          context.signal.addEventListener("abort", () => controller.abort(context.signal.reason), { once: true });
        }
      }

      try {
        const output = await tool.execute(input, { ...context, signal: controller.signal });
        const outputSchema = tool.outputSchema;
        if (outputSchema) {
          const parsed = outputSchema.safeParse(output);
          if (!parsed.success) {
            return { ok: false, error: { code: "VALIDATION_ERROR", message: `Tool output validation failed: ${parsed.error.message}` } };
          }
        }
        return { ok: true, output };
      } catch (err) {
        if (err && (err as any).name === "AbortError") {
          return { ok: false, error: { code: "TOOL_CALL_TIMED_OUT", message: `Tool execution timed out after ${timeoutMs}ms` } };
        }
        const frameworkError = err instanceof BaseFrameworkError ? err : new ToolError(String(err), { cause: err, runId: context.runId, toolCallId: context.toolCallId });
        if (controller.signal.aborted) {
          return { ok: false, error: { code: "TOOL_CALL_TIMED_OUT", message: `Tool execution timed out after ${timeoutMs}ms` } };
        }
        return { ok: false, error: { code: frameworkError.code, message: frameworkError.message } };
      } finally {
        clearTimeout(timeoutId);
      }
    };

    while (attempt < (retryConfig?.maxAttempts ?? 1)) {
      attempt++;
      const result = await runWithTimeout();
      if (result.ok) {
        return result;
      }
      lastError = result;

      const retryable = isRetryable(result.error?.code);
      if (!retryable || attempt >= (retryConfig?.maxAttempts ?? 1)) {
        return { ok: false, error: lastError.error };
      }

      const delayMs = computeBackoff(retryConfig, attempt);
      if (delayMs > 0) {
        await sleep(delayMs, context.signal);
      }
    }

    return { ok: false, error: lastError?.error };
  }

  private async emitObservation(observation: ToolObservation): Promise<void> {
    await this.observationEmitter.emit(observation);
  }

  private async audit(observation: ToolObservation, authorized: boolean, reason?: string): Promise<void> {
    const entry: ToolAuditEntry = {
      toolCallId: observation.toolCallId,
      runId: observation.runId,
      agentId: observation.agentId,
      userId: observation.userId,
      tenantId: observation.tenantId,
      toolName: observation.toolName,
      toolVersion: observation.toolVersion,
      input: observation.input,
      output: observation.output,
      status: observation.status,
      authorized,
      reason,
      requestedAt: observation.startedAt,
      completedAt: observation.completedAt,
      metadata: Object.assign({}, observation.durationMs ? { durationMs: observation.durationMs } : {}, observation.metadata ? {} : {}),
    };
    await this.auditStore.record(entry);
  }
}

export function validateInput<TInput>(tool: Tool<TInput, unknown>, input: unknown): ValidatedToolInput<TInput> {
  try {
    const parsed = tool.inputSchema.safeParse(input);
    if (parsed.success) {
      return { ok: true, value: parsed.data };
    }
    const message = parsed.error && typeof parsed.error === "object" && "message" in parsed.error ? String((parsed.error as any).message) : "Invalid tool input";
    return { ok: false, error: { code: "VALIDATION_ERROR", message: `Invalid tool input: ${message}` } };
  } catch (err) {
    return { ok: false, error: { code: "VALIDATION_ERROR", message: "Input validation failed" } };
  }
}

export function isRetryable(code: string | undefined): boolean {
  return code === "LLM_ERROR" || code === "INFRASTRUCTURE_ERROR" || code === "TOOL_ERROR" || code === "VALIDATION_ERROR";
}

function computeBackoff(config: ToolRetryConfig | undefined, attempt: number): number {
  if (!config) return 0;
  const initial = config.initialDelayMs ?? 100;
  if (config.backoff === "exponential") {
    return initial * Math.pow(2, attempt - 1);
  }
  return initial;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const id = setTimeout(() => resolve(), ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(id);
      reject(new Error("Aborted"));
    }, { once: true });
  });
}
