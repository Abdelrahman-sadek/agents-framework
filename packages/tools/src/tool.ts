import { ConfigurationError, type AgentTool, type JsonSchema, type Principal } from "@agent-framework/core";
import { z } from "zod";

/** How a tool reaches the outside world. MCP, HTTP, sandbox… are adapters producing ordinary tools. */
export type ToolKind = "native" | "http" | "database" | "filesystem" | "sandbox" | "mcp" | "custom";

export interface ToolContext {
  runId: string;
  toolCallId: string;
  stepId?: string;
  agentId: string;
  user?: Principal;
  /** Aborted on timeout, run cancellation or run timeout. Long-running tools must honour it. */
  signal: AbortSignal;
  /** 1-based attempt number. */
  attempt: number;
}

export interface ToolRetryPolicy {
  /** Total attempts including the first one. Default 1 (no retry). */
  maxAttempts: number;
  backoff?: "fixed" | "exponential";
  initialDelayMs?: number;
  maxDelayMs?: number;
  /**
   * Retry after a timeout. Off by default: a timed-out call may still have had
   * side effects. Only enable it for idempotent tools.
   */
  retryOnTimeout?: boolean;
}

export interface ToolRateLimit {
  maxCalls: number;
  windowMs: number;
  /** Bucket per tool (`global`), per tenant or per user. Default `global`. */
  scope?: "global" | "tenant" | "user";
}

export interface ToolIdempotency<TInput> {
  /** Derive the idempotency key. Same key → the stored successful result is returned instead of re-executing. */
  key: (input: TInput, context: { user?: Principal; runId: string }) => string;
  ttlMs?: number;
}

export interface ToolApproval<TInput> {
  /** `true`, or a predicate over the validated input (e.g. only amounts above a threshold). */
  required: boolean | ((input: TInput, context: { user?: Principal }) => boolean);
  /** Approval requests expire after this long. */
  expiresInMs?: number;
  /** Shown to the reviewer. */
  reason?: string;
}

export interface ToolConfig<TInput, TOutput> {
  /** Letters, digits, `_`, `-`; max 64 chars (portable across model providers). */
  name: string;
  description: string;
  version?: string;
  kind?: ToolKind;
  input: z.ZodType<TInput>;
  output?: z.ZodType<TOutput>;
  execute: (input: TInput, context: ToolContext) => Promise<TOutput> | TOutput;
  /** Permissions required on BOTH the agent and the user. */
  permissions?: readonly string[];
  /** Per-attempt timeout. Default 30 000 ms. */
  timeoutMs?: number;
  retry?: ToolRetryPolicy;
  rateLimit?: ToolRateLimit;
  /** Maximum concurrent executions of this tool within one ToolRuntime. */
  concurrency?: number;
  idempotency?: ToolIdempotency<TInput>;
  approval?: ToolApproval<TInput>;
  /** Redact input from audit records. */
  sensitive?: boolean;
  /** Application metadata for policies and audit. Never sent to a model. */
  metadata?: Readonly<Record<string, unknown>>;
}

const TOOL_BRAND: unique symbol = Symbol.for("@agent-framework/tools.Tool");
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export interface Tool<TInput = unknown, TOutput = unknown> extends AgentTool {
  readonly [TOOL_BRAND]: true;
  readonly kind: ToolKind;
  readonly version: string | undefined;
  readonly definition: Readonly<ToolConfig<TInput, TOutput>>;
}

/** A tool of any input/output type. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance escape hatch for heterogeneous tool lists
export type AnyTool = Tool<any, any>;

export function defineTool<TInput, TOutput>(config: ToolConfig<TInput, TOutput>): Tool<TInput, TOutput> {
  const where = `Tool '${String(config.name)}'`;
  if (typeof config.name !== "string" || !TOOL_NAME.test(config.name)) {
    throw new ConfigurationError(`${where}: name must match ${TOOL_NAME.source}`);
  }
  if (typeof config.description !== "string" || config.description.trim() === "") {
    throw new ConfigurationError(`${where}: description is required (the model relies on it)`);
  }
  if (!(config.input instanceof z.ZodType)) throw new ConfigurationError(`${where}: input must be a Zod schema`);
  if (config.output !== undefined && !(config.output instanceof z.ZodType)) {
    throw new ConfigurationError(`${where}: output must be a Zod schema`);
  }
  if (typeof config.execute !== "function") throw new ConfigurationError(`${where}: execute must be a function`);
  positive(where, "timeoutMs", config.timeoutMs);
  positive(where, "concurrency", config.concurrency);
  positive(where, "retry.maxAttempts", config.retry?.maxAttempts);
  positive(where, "rateLimit.maxCalls", config.rateLimit?.maxCalls);
  positive(where, "rateLimit.windowMs", config.rateLimit?.windowMs);
  positive(where, "approval.expiresInMs", config.approval?.expiresInMs);

  let parameters: JsonSchema;
  try {
    const { $schema: _ignored, ...schema } = z.toJSONSchema(config.input, { io: "input", unrepresentable: "any" });
    parameters = Object.freeze(schema);
  } catch (cause) {
    throw new ConfigurationError(`${where}: input schema cannot be converted to JSON Schema`, { cause });
  }

  return Object.freeze({
    [TOOL_BRAND]: true as const,
    name: config.name,
    description: config.description,
    parameters,
    kind: config.kind ?? "native",
    version: config.version,
    definition: Object.freeze({ ...config, permissions: Object.freeze([...(config.permissions ?? [])]) }),
  });
}

export function isTool(value: unknown): value is AnyTool {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[TOOL_BRAND] === true;
}

function positive(where: string, field: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new ConfigurationError(`${where}: ${field} must be a positive integer`);
  }
}
