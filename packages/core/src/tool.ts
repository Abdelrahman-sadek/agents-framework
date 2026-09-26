import type { RunLimits, ToolPermissions, ApprovalConfig } from "./types.js";

export interface ToolDefinition<TInput, TOutput> {
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  version?: string;
}

export interface ToolConfig<TInput, TOutput> extends ToolDefinition<TInput, TOutput> {
  execute: ToolExecutor<TInput, TOutput>;
  permissions?: ToolPermissions;
  timeout?: number;
  retry?: RunLimits;
  approvals?: ApprovalConfig;
  idempotencyKey?: string | boolean;
}

export type ToolExecutor<TInput, TOutput> = (input: TInput, context: ToolExecutionContext) => Promise<TOutput>;

export interface ToolExecutionContext {
  runId: string;
  stepId?: string;
  toolCallId: string;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ToolCallRequest<TInput> {
  toolName: string;
  toolVersion?: string;
  input: TInput;
  callId: string;
  runId: string;
  stepId?: string;
  permitted: boolean;
}

export interface ToolCallResult<TOutput> {
  ok: boolean;
  output?: TOutput;
  error?: { code: string; message: string };
  metadata?: Record<string, unknown>;
}

export interface ToolCallRecord {
  toolCallId: string;
  runId: string;
  stepId?: string;
  toolName: string;
  toolVersion?: string;
  input?: unknown;
  output?: unknown;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "REJECTED" | "APPROVAL_REQUIRED" | "TIMED_OUT";
  authorizedBy?: string;
  permissionScope?: string[];
  startedAt?: string;
  completedAt?: string;
  error?: { code: string; message: string };
  retryCount?: number;
}
