/**
 * @agent-framework/tools — tool definition and the deterministic tool runtime.
 */
export { defineTool, isTool } from "./tool.js";
export type {
  AnyTool,
  Tool,
  ToolApproval,
  ToolConfig,
  ToolContext,
  ToolIdempotency,
  ToolKind,
  ToolRateLimit,
  ToolRetryPolicy,
} from "./tool.js";

export { ToolRuntime, hashArguments } from "./tool-runtime.js";
export type { ExecuteToolOptions, ToolExecutionResult, ToolRuntimeOptions } from "./tool-runtime.js";

export { allOf, decisionPolicy, permissionPolicy, policy } from "./policy.js";
export type { PermissionPolicyOptions, ToolAuthorizationDecision, ToolAuthorizationRequest, ToolPolicy } from "./policy.js";

export { InMemoryAuditLog, InMemoryIdempotencyStore, InMemoryRateLimiter } from "./stores.js";
export type { AuditSink, IdempotencyStore, RateLimiter, ToolAuditRecord } from "./stores.js";
