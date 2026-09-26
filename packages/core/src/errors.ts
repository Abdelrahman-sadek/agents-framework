import type { FrameworkError } from "./types.js";

export class BaseFrameworkError extends Error implements FrameworkError {
  public readonly code: string;
  public readonly retryable: boolean;
  public readonly metadata: Record<string, unknown>;
  public readonly runId?: string;
  public readonly stepId?: string;
  public readonly toolCallId?: string;
  public readonly llmCallId?: string;
  public readonly name: string;

  constructor(
    code: string,
    message: string,
    options?: {
      cause?: unknown;
      retryable?: boolean;
      metadata?: Record<string, unknown>;
      runId?: string;
      stepId?: string;
      toolCallId?: string;
      llmCallId?: string;
    },
  ) {
    super(message);
    this.name = "BaseFrameworkError";
    this.code = code;
    this.message = message;
    this.retryable = options?.retryable ?? false;
    this.metadata = options?.metadata ?? {};
    this.cause = options?.cause;
    this.runId = options?.runId;
    this.stepId = options?.stepId;
    this.toolCallId = options?.toolCallId;
    this.llmCallId = options?.llmCallId;
    Object.setPrototypeOf(this, BaseFrameworkError.prototype);
  }
}

export class AgentError extends BaseFrameworkError {
  constructor(message: string, options?: BaseFrameworkError["constructor"]["prototype"] & { cause?: unknown; runId?: string }) {
    super("AGENT_ERROR", message, { retryable: false, ...options });
    this.name = "AgentError";
  }
}

export class ValidationError extends BaseFrameworkError {
  constructor(message: string, options?: { cause?: unknown; metadata?: Record<string, unknown>; retryable?: boolean }) {
    super("VALIDATION_ERROR", message, { retryable: options?.retryable ?? true, ...options });
    this.name = "ValidationError";
  }
}

export class ToolError extends BaseFrameworkError {
  constructor(
    message: string,
    options?: {
      cause?: unknown;
      retryable?: boolean;
      runId?: string;
      stepId?: string;
      toolCallId?: string;
      metadata?: Record<string, unknown>;
    },
  ) {
    super("TOOL_ERROR", message, options);
    this.name = "ToolError";
  }
}

export class ToolAuthorizationError extends BaseFrameworkError {
  constructor(message: string, options?: { runId?: string; toolCallId?: string; stepId?: string }) {
    super("TOOL_AUTHORIZATION_ERROR", message, { retryable: false, ...options });
    this.name = "ToolAuthorizationError";
  }
}

export class LLMError extends BaseFrameworkError {
  constructor(
    message: string,
    options?: {
      cause?: unknown;
      retryable?: boolean;
      runId?: string;
      stepId?: string;
      llmCallId?: string;
      metadata?: Record<string, unknown>;
    },
  ) {
    super("LLM_ERROR", message, options);
    this.name = "LLMError";
  }
}

export class AuthorizationError extends BaseFrameworkError {
  constructor(message: string, options?: { runId?: string }) {
    super("AUTHORIZATION_ERROR", message, { retryable: false, ...options });
    this.name = "AuthorizationError";
  }
}

export class ContextLimitError extends BaseFrameworkError {
  constructor(message: string, options?: { runId?: string; metadata?: Record<string, unknown> }) {
    super("CONTEXT_LIMIT_ERROR", message, { retryable: false, ...options });
    this.name = "ContextLimitError";
  }
}

export class MemoryError extends BaseFrameworkError {
  constructor(message: string, options?: { cause?: unknown; retryable?: boolean }) {
    super("MEMORY_ERROR", message, { retryable: options?.retryable ?? false, ...options });
    this.name = "MemoryError";
  }
}

export class KnowledgeError extends BaseFrameworkError {
  constructor(message: string, options?: { cause?: unknown; retryable?: boolean }) {
    super("KNOWLEDGE_ERROR", message, { retryable: options?.retryable ?? false, ...options });
    this.name = "KnowledgeError";
  }
}

export class PlanningError extends BaseFrameworkError {
  constructor(message: string, options?: { cause?: unknown; runId?: string }) {
    super("PLANNING_ERROR", message, { retryable: true, ...options });
    this.name = "PlanningError";
  }
}

export class ExecutionError extends BaseFrameworkError {
  constructor(
    message: string,
    options?: {
      cause?: unknown;
      retryable?: boolean;
      runId?: string;
      stepId?: string;
      metadata?: Record<string, unknown>;
    },
  ) {
    super("EXECUTION_ERROR", message, options);
    this.name = "ExecutionError";
  }
}

export class ApprovalRequiredError extends BaseFrameworkError {
  constructor(message: string, options?: { runId?: string; stepId?: string; toolCallId?: string }) {
    super("APPROVAL_REQUIRED_ERROR", message, { retryable: false, ...options });
    this.name = "ApprovalRequiredError";
  }
}

export class PolicyViolationError extends BaseFrameworkError {
  constructor(message: string, options?: { runId?: string; metadata?: Record<string, unknown> }) {
    super("POLICY_VIOLATION_ERROR", message, { retryable: false, ...options });
    this.name = "PolicyViolationError";
  }
}

export class InfrastructureError extends BaseFrameworkError {
  constructor(message: string, options?: { cause?: unknown; retryable?: boolean }) {
    super("INFRASTRUCTURE_ERROR", message, { retryable: options?.retryable ?? true, ...options });
    this.name = "InfrastructureError";
  }
}
