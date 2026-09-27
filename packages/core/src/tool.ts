import type { SerializedError } from "./errors.js";
import type { EmitFn } from "./events.js";
import type { RunIdentity } from "./identity.js";
import type { JsonSchema } from "./schema.js";

/**
 * Core-owned tool port.
 *
 * The agent runtime only knows that a tool has a name, a description and a
 * parameter schema, and that calls go through a `ToolInvoker`. Validation,
 * authorization, approval, reliability and audit live behind the invoker
 * (`@agent-framework/tools`), so the model can never reach `execute` directly.
 */
export interface AgentTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
}

export interface ApprovalRequest {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  /** Hash of the validated arguments. An approval is only valid for these exact arguments. */
  argumentsHash: string;
  requestedAt: string;
  expiresAt?: string;
  reason?: string;
  /** Reviewers this approval was escalated to, in order. */
  escalatedTo?: string[];
}

export interface ApprovalDecision {
  approvalId: string;
  /**
   * - `approved`: execute with the original arguments
   * - `modified`: execute with `modifiedArguments` (re-validated and re-authorized)
   * - `rejected`: do not execute; the model is told
   * - `escalated`: stays pending, handed to `escalateTo`
   */
  decision: "approved" | "rejected" | "modified" | "escalated";
  decidedBy?: string;
  reason?: string;
  modifiedArguments?: unknown;
  escalateTo?: string;
}

export interface ToolInvocation {
  tool: AgentTool;
  toolCallId: string;
  /** Raw arguments (JSON string from a model, or an object from application code). */
  rawArguments: unknown;
  runId: string;
  stepId?: string;
  llmCallId?: string;
  identity: RunIdentity;
  signal: AbortSignal;
  emit: EmitFn;
  /** Present when resuming a call that previously required approval. */
  approval?: { request: ApprovalRequest; decision: ApprovalDecision };
}

export type ToolInvocationStatus = "success" | "error" | "denied" | "approval_required" | "rejected";

export interface ToolInvocationResult {
  status: ToolInvocationStatus;
  output?: unknown;
  error?: SerializedError;
  approval?: ApprovalRequest;
  attempts: number;
  durationMs: number;
  /** True when the result came from the idempotency store instead of a new execution. */
  cached: boolean;
}

export interface ToolInvoker {
  invoke(invocation: ToolInvocation): Promise<ToolInvocationResult>;
}
