/**
 * Framework error model.
 *
 * Every error the runtime produces is a `FrameworkError` carrying a stable
 * `code`, a `category`, a `retryable` flag and correlation identifiers. Errors
 * are serialized with `toJSON()` before they cross a trust boundary (events,
 * results, persisted state, tool messages sent to a model).
 */

export type ErrorCategory =
  | "developer"
  | "validation"
  | "provider"
  | "tool"
  | "authorization"
  | "execution"
  | "infrastructure"
  | "policy";

export interface ErrorCorrelation {
  runId?: string;
  stepId?: string;
  toolCallId?: string;
  llmCallId?: string;
}

export interface FrameworkErrorOptions extends ErrorCorrelation {
  cause?: unknown;
  retryable?: boolean;
  metadata?: Record<string, unknown>;
}

export interface SerializedError extends ErrorCorrelation {
  code: string;
  message: string;
  category: ErrorCategory;
  retryable: boolean;
  metadata?: Record<string, unknown>;
}

export class FrameworkError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly metadata: Record<string, unknown>;
  readonly runId: string | undefined;
  readonly stepId: string | undefined;
  readonly toolCallId: string | undefined;
  readonly llmCallId: string | undefined;

  constructor(code: string, category: ErrorCategory, message: string, options: FrameworkErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "FrameworkError";
    this.code = code;
    this.category = category;
    this.retryable = options.retryable ?? false;
    this.metadata = options.metadata ?? {};
    this.runId = options.runId;
    this.stepId = options.stepId;
    this.toolCallId = options.toolCallId;
    this.llmCallId = options.llmCallId;
  }

  toJSON(): SerializedError {
    const out: SerializedError = {
      code: this.code,
      message: this.message,
      category: this.category,
      retryable: this.retryable,
    };
    if (Object.keys(this.metadata).length > 0) out.metadata = this.metadata;
    if (this.runId !== undefined) out.runId = this.runId;
    if (this.stepId !== undefined) out.stepId = this.stepId;
    if (this.toolCallId !== undefined) out.toolCallId = this.toolCallId;
    if (this.llmCallId !== undefined) out.llmCallId = this.llmCallId;
    return out;
  }

  /** Normalize any thrown value into a FrameworkError without losing the cause. */
  static from(error: unknown, fallback: (message: string, cause: unknown) => FrameworkError = defaultFallback): FrameworkError {
    if (error instanceof FrameworkError) return error;
    const message = error instanceof Error ? error.message : String(error);
    return fallback(message, error);
  }
}

const defaultFallback = (message: string, cause: unknown): FrameworkError => new ExecutionError(message, { cause });

type Opts = FrameworkErrorOptions;

/** Invalid framework, agent or tool configuration. Thrown eagerly; never retryable. */
export class ConfigurationError extends FrameworkError {
  constructor(message: string, options: Opts = {}) {
    super("CONFIGURATION_ERROR", "developer", message, { ...options, retryable: false });
    this.name = "ConfigurationError";
  }
}

export class AgentError extends FrameworkError {
  constructor(message: string, options: Opts = {}) {
    super("AGENT_ERROR", "execution", message, options);
    this.name = "AgentError";
  }
}

export class ValidationError extends FrameworkError {
  constructor(message: string, options: Opts = {}) {
    super("VALIDATION_ERROR", "validation", message, options);
    this.name = "ValidationError";
  }
}

export class OutputValidationError extends FrameworkError {
  constructor(message: string, options: Opts = {}) {
    super("OUTPUT_VALIDATION_ERROR", "validation", message, options);
    this.name = "OutputValidationError";
  }
}

export class LLMError extends FrameworkError {
  constructor(message: string, options: Opts = {}) {
    super("LLM_ERROR", "provider", message, options);
    this.name = "LLMError";
  }
}

export class ToolError extends FrameworkError {
  constructor(message: string, options: Opts = {}) {
    super("TOOL_ERROR", "tool", message, options);
    this.name = "ToolError";
  }
}

export class ToolTimeoutError extends FrameworkError {
  constructor(message: string, options: Opts = {}) {
    super("TOOL_TIMEOUT", "tool", message, options);
    this.name = "ToolTimeoutError";
  }
}

export class ToolNotFoundError extends FrameworkError {
  constructor(message: string, options: Opts = {}) {
    super("TOOL_NOT_FOUND", "validation", message, { ...options, retryable: false });
    this.name = "ToolNotFoundError";
  }
}

export class AuthorizationError extends FrameworkError {
  constructor(message: string, options: Opts = {}) {
    super("AUTHORIZATION_ERROR", "authorization", message, { ...options, retryable: false });
    this.name = "AuthorizationError";
  }
}

export class ToolAuthorizationError extends FrameworkError {
  constructor(message: string, options: Opts = {}) {
    super("TOOL_AUTHORIZATION_ERROR", "authorization", message, { ...options, retryable: false });
    this.name = "ToolAuthorizationError";
  }
}

export class ApprovalRequiredError extends FrameworkError {
  constructor(message: string, options: Opts = {}) {
    super("APPROVAL_REQUIRED", "policy", message, { ...options, retryable: false });
    this.name = "ApprovalRequiredError";
  }
}

export class ApprovalRejectedError extends FrameworkError {
  constructor(message: string, options: Opts = {}) {
    super("APPROVAL_REJECTED", "policy", message, { ...options, retryable: false });
    this.name = "ApprovalRejectedError";
  }
}

export class ApprovalExpiredError extends FrameworkError {
  constructor(message: string, options: Opts = {}) {
    super("APPROVAL_EXPIRED", "policy", message, { ...options, retryable: false });
    this.name = "ApprovalExpiredError";
  }
}

export class RateLimitError extends FrameworkError {
  constructor(message: string, options: Opts = {}) {
    super("RATE_LIMITED", "policy", message, { retryable: true, ...options });
    this.name = "RateLimitError";
  }
}

export type LimitType = "steps" | "toolCalls" | "tokens" | "cost";

/** A configured run limit or budget was reached. */
export class LimitExceededError extends FrameworkError {
  readonly limitType: LimitType;
  constructor(limitType: LimitType, limit: number, current: number, options: Opts = {}) {
    super("LIMIT_EXCEEDED", "policy", `Run limit exceeded: ${limitType} (limit ${limit}, current ${current})`, {
      ...options,
      retryable: false,
      metadata: { ...options.metadata, limitType, limit, current },
    });
    this.name = "LimitExceededError";
    this.limitType = limitType;
  }
}

export class CancellationError extends FrameworkError {
  constructor(message = "Run was cancelled", options: Opts = {}) {
    super("CANCELLED", "execution", message, { ...options, retryable: false });
    this.name = "CancellationError";
  }
}

export class RunTimeoutError extends FrameworkError {
  constructor(timeoutMs: number, options: Opts = {}) {
    super("RUN_TIMEOUT", "execution", `Run exceeded its timeout of ${timeoutMs}ms`, {
      ...options,
      retryable: false,
      metadata: { ...options.metadata, timeoutMs },
    });
    this.name = "RunTimeoutError";
  }
}

export class ExecutionError extends FrameworkError {
  constructor(message: string, options: Opts = {}) {
    super("EXECUTION_ERROR", "execution", message, options);
    this.name = "ExecutionError";
  }
}

export class PolicyViolationError extends FrameworkError {
  constructor(message: string, options: Opts = {}) {
    super("POLICY_VIOLATION", "policy", message, { ...options, retryable: false });
    this.name = "PolicyViolationError";
  }
}

export class InfrastructureError extends FrameworkError {
  constructor(message: string, options: Opts = {}) {
    super("INFRASTRUCTURE_ERROR", "infrastructure", message, { retryable: true, ...options });
    this.name = "InfrastructureError";
  }
}

export class VerificationError extends FrameworkError {
  constructor(message: string, options: Opts = {}) {
    super("VERIFICATION_FAILED", "validation", message, { ...options, retryable: false });
    this.name = "VerificationError";
  }
}

export class GuardrailError extends FrameworkError {
  constructor(message: string, options: Opts = {}) {
    super("GUARDRAIL_BLOCKED", "policy", message, { ...options, retryable: false });
    this.name = "GuardrailError";
  }
}

// Reserved for later phases; defined now so error codes stay stable.
export class ContextLimitError extends FrameworkError {
  constructor(message: string, options: Opts = {}) {
    super("CONTEXT_LIMIT_ERROR", "execution", message, options);
    this.name = "ContextLimitError";
  }
}

export class MemoryError extends FrameworkError {
  constructor(message: string, options: Opts = {}) {
    super("MEMORY_ERROR", "infrastructure", message, options);
    this.name = "MemoryError";
  }
}

export class KnowledgeError extends FrameworkError {
  constructor(message: string, options: Opts = {}) {
    super("KNOWLEDGE_ERROR", "infrastructure", message, options);
    this.name = "KnowledgeError";
  }
}

export class PlanningError extends FrameworkError {
  constructor(message: string, options: Opts = {}) {
    super("PLANNING_ERROR", "execution", message, options);
    this.name = "PlanningError";
  }
}

export function isRetryable(error: unknown): boolean {
  return error instanceof FrameworkError && error.retryable;
}
