export type Duration = number | { milliseconds: number } | { seconds: number };

export interface RunLimits {
  maxSteps?: number;
  maxToolCalls?: number;
  maxTokens?: number;
  maxCost?: number;
  timeout?: Duration;
  maxRetries?: number;
  maxReflectionAttempts?: number;
}

export interface RunConfig<TInput = unknown> {
  input: TInput;
  metadata?: Record<string, unknown>;
  limits?: RunLimits;
  signal?: AbortSignal;
}

export type AgentStatus =
  | "CREATED"
  | "INITIALIZING"
  | "QUEUED"
  | "RUNNING"
  | "WAITING_FOR_APPROVAL"
  | "REFLECTING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT"
  | "APPROVAL_REJECTED"
  | "APPROVAL_EXPIRED";

export interface AgentState {
  runId: string;
  agentId: string;
  status: AgentStatus;
  input: unknown;
  context: ContextState;
  plan?: Plan;
  steps: ExecutionStep[];
  metadata: Record<string, unknown>;
  startedAt: string;
  updatedAt: string;
  error?: FrameworkError;
  budgetUsed?: BudgetUsage;
}

export interface ContextState {
  maxTokens: number;
  includeMemory: boolean;
  includeToolHistory: boolean;
  summarizeHistoryAfter: number;
}

export interface Plan {
  goal: string;
  steps: PlanStep[];
}

export interface PlanStep {
  id: string;
  description: string;
  dependencies?: string[];
  status: StepStatus;
  worker?: string;
  inputs?: unknown;
  outputs?: unknown;
  timeout?: Duration;
  retryPolicy?: RetryPolicy;
}

export type StepStatus =
  | "PENDING"
  | "SCHEDULED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export interface ExecutionStep {
  stepId: string;
  description: string;
  status: StepStatus;
  worker?: string;
  inputs?: unknown;
  outputs?: unknown;
  startedAt?: string;
  completedAt?: string;
  error?: FrameworkError;
  retryCount?: number;
}

export interface RetryPolicy {
  maxAttempts: number;
  backoff?: "fixed" | "exponential";
  initialDelay?: Duration;
}

export interface BudgetUsage {
  tokens: number;
  estimatedCost: number;
  steps: number;
  toolCalls: number;
}

export interface ToolPermissions {
  allowed?: string[];
  denied?: string[];
  dataScope?: string[];
}

export interface ToolAuthorizationContext {
  runId: string;
  agentId: string;
  userId?: string;
  tenantId?: string;
  organizationId?: string;
  toolName: string;
  toolVersion?: string;
  input: unknown;
  requestedAction?: string;
}

export interface ToolAuthorizationResult {
  allowed: boolean;
  reason?: string;
  requiredApproval?: boolean;
  approvalId?: string;
  permissionScope?: string[];
}

export interface ToolRateLimitConfig {
  maxPerPeriod?: number;
  periodMs?: number;
  key?: string;
}

export interface ToolIdempotencyConfig {
  enabled?: boolean;
  key?: string | boolean;
  ttlMs?: number;
}

export interface ToolObservation {
  toolCallId: string;
  runId: string;
  agentId: string;
  toolName: string;
  toolVersion?: string;
  input?: unknown;
  output?: unknown;
  status: string;
  startedAt?: string;
  completedAt?: string;
  error?: { code: string; message: string };
  authorizedBy?: string;
  permissionScope?: string[];
  retryCount?: number;
  durationMs?: number;
}

export interface ToolAuditEntry {
  toolCallId: string;
  runId: string;
  agentId: string;
  userId?: string;
  tenantId?: string;
  toolName: string;
  toolVersion?: string;
  input?: unknown;
  output?: unknown;
  status: string;
  authorized: boolean;
  reason?: string;
  requestedAt?: string;
  completedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface ModelCapabilities {
  providerId: string;
  modelId: string;
  local: boolean;
  contextWindowTokens?: number;
  structuredOutput?: boolean;
  toolCalling?: boolean;
  streaming?: boolean;
  vision?: boolean;
  embedding?: boolean;
  costPerMillionInputTokens?: number;
  costPerMillionOutputTokens?: number;
  latencyMs?: number;
}

export interface ApprovalConfig {
  required?: boolean;
  expiration?: Duration;
  escalation?: string[];
}

export interface ToolEventPayload {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  status: string;
  startedAt?: string;
  completedAt?: string;
  error?: FrameworkError;
  retryCount?: number;
}

export interface LLMEventPayload {
  llmCallId: string;
  provider: string;
  model: string;
  status: string;
  tokenUsage?: TokenUsage;
  estimatedCost?: number;
  error?: FrameworkError;
  startedAt?: string;
  completedAt?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
}

export interface EventEnvelope {
  eventId: string;
  runId: string;
  agentId: string;
  occurredAt: string;
  type: string;
  actor?: string;
  correlationId?: string;
  payload: unknown;
  metadata?: Record<string, unknown>;
}

export interface BudgetExceededOptions {
  runId: string;
  limitType: "tokens" | "cost" | "steps" | "toolCalls";
  limit: number;
  current: number;
}

export interface ApprovalEventPayload {
  approvalId: string;
  runId: string;
  stepId?: string;
  toolCallId?: string;
  actionDescription: string;
  status: string;
  requestedAt: string;
  expiresAt?: string;
}
