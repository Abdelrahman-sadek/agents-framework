import { z } from "zod";
import type { ToolExecutionContext } from "@agent-framework/core";

export type ToolInputSchema<TInput> = z.ZodSchema<TInput>;
export type ToolOutputSchema<TOutput> = z.ZodSchema<TOutput>;

export interface ToolDefinition<TInput, TOutput> {
  name: string;
  description: string;
  inputSchema: ToolInputSchema<TInput>;
  outputSchema?: ToolOutputSchema<TOutput>;
  version?: string;
}

export interface ToolConfiguration<TInput, TOutput> extends ToolDefinition<TInput, TOutput> {
  execute: (input: TInput, context: ToolExecutionContext) => Promise<TOutput>;
  permissions?: ToolPermissions;
  timeoutMs?: number;
  retry?: ToolRetryConfig;
  rateLimit?: ToolRateLimitConfig;
  idempotency?: ToolIdempotencyConfig;
  approval?: ToolApprovalConfig;
  metadata?: Record<string, unknown>;
}

export type Tool<TInput, TOutput> = ToolConfiguration<TInput, TOutput>;

export interface ToolPermissions {
  allowed?: string[];
  denied?: string[];
  dataScope?: string[];
}

export interface ToolRetryConfig {
  maxAttempts: number;
  backoff?: "fixed" | "exponential";
  initialDelayMs?: number;
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

export interface ToolApprovalConfig {
  required?: boolean;
  expirationMs?: number;
  escalation?: string[];
}

export interface ToolExecutionContext {
  runId: string;
  agentId: string;
  userId?: string;
  tenantId?: string;
  organizationId?: string;
  toolCallId: string;
  stepId?: string;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ToolCallRequest<TInput> {
  tool: Tool<TInput, unknown>;
  input: TInput;
  callId: string;
  runId: string;
  agentId: string;
  userId?: string;
  tenantId?: string;
  organizationId?: string;
  stepId?: string;
}

export interface ToolAuthorizationContext extends ToolExecutionContext {
  toolName: string;
  toolVersion?: string;
  input: unknown;
  requestedAction?: string;
  permissions?: ToolPermissions;
}

export interface ToolAuthorizationResult {
  allowed: boolean;
  reason?: string;
  requiredApproval?: boolean;
  approvalId?: string;
  permissionScope?: string[];
}

export interface ToolResult<TOutput> {
  ok: boolean;
  output?: TOutput;
  error?: { code: string; message: string };
  metadata?: Record<string, unknown>;
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
  audit?: ToolAuditEntry;
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

export type ValidatedToolInput<TInput> = {
  ok: true;
  value: TInput;
} | {
  ok: false;
  error: { code: string; message: string };
};
