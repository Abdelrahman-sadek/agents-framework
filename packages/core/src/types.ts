import type { SerializedError } from "./errors.js";
import type { Principal } from "./identity.js";
import type { LLMMessage, LLMToolCall } from "./llm.js";
import type { ApprovalRequest } from "./tool.js";

/**
 * Hard limits for a run. Every intelligent operation is bounded; the runtime,
 * not the model, enforces these.
 */
export interface RunLimits {
  /** Maximum model calls in one run. */
  maxSteps?: number;
  /** Maximum tool calls requested in one run (including denied ones). */
  maxToolCalls?: number;
  /** Maximum input + output tokens across the run. */
  maxTokens?: number;
  /** Maximum estimated cost in USD across the run. */
  maxCost?: number;
  /** Wall-clock timeout for one `run()` / `resume()` invocation. */
  timeoutMs?: number;
  /** Retries for retryable model errors, per model call. */
  maxLLMRetries?: number;
}

export interface ResolvedRunLimits {
  maxSteps: number;
  maxToolCalls: number;
  maxTokens: number | undefined;
  maxCost: number | undefined;
  timeoutMs: number;
  maxLLMRetries: number;
}

export const DEFAULT_RUN_LIMITS: ResolvedRunLimits = Object.freeze({
  maxSteps: 10,
  maxToolCalls: 25,
  maxTokens: undefined,
  maxCost: undefined,
  timeoutMs: 120_000,
  maxLLMRetries: 2,
});

export type AgentStatus =
  | "CREATED"
  | "RUNNING"
  | "WAITING_FOR_APPROVAL"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT"
  | "APPROVAL_EXPIRED";

export const TERMINAL_STATUSES: ReadonlySet<AgentStatus> = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
  "APPROVAL_EXPIRED",
]);

export type StepKind = "llm_call" | "tool_call";
export type StepStatus = "RUNNING" | "COMPLETED" | "FAILED" | "WAITING_FOR_APPROVAL" | "REJECTED";

export interface ExecutionStep {
  stepId: string;
  index: number;
  kind: StepKind;
  status: StepStatus;
  startedAt: string;
  completedAt?: string;
  llmCallId?: string;
  toolCallId?: string;
  toolName?: string;
  attempts?: number;
  error?: SerializedError;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  llmCalls: number;
  toolCalls: number;
}

export interface PendingApproval {
  approval: ApprovalRequest;
  toolCall: LLMToolCall;
  stepId: string;
  llmCallId: string;
}

/**
 * Complete, serializable run state. Everything needed to inspect or resume a
 * run lives here — never only inside a prompt.
 */
export interface AgentState {
  runId: string;
  agentId: string;
  agentVersion?: string;
  status: AgentStatus;
  input: unknown;
  user?: Principal;
  messages: LLMMessage[];
  steps: ExecutionStep[];
  usage: UsageTotals;
  pendingApprovals: PendingApproval[];
  limits: ResolvedRunLimits;
  metadata: Record<string, unknown>;
  output?: unknown;
  error?: SerializedError;
  /** Last event sequence number, so resumed runs continue the event stream. */
  eventSequence: number;
  createdAt: string;
  updatedAt: string;
}

export function emptyUsage(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    llmCalls: 0,
    toolCalls: 0,
  };
}
