export { Tool, ToolConfig, ToolConfiguration, ToolDefinition, ToolInputSchema, ToolOutputSchema, ToolPermissions, ToolRetryConfig, ToolRateLimitConfig, ToolIdempotencyConfig, ToolApprovalConfig, ToolExecutionContext, ToolCallRequest, ToolAuthorizationContext, ToolAuthorizationResult, ToolResult, ToolObservation, ToolAuditEntry, ValidatedToolInput } from "./tool-definition.js";

export interface DefineToolConfig<TInput, TOutput> extends ToolConfiguration<TInput, TOutput> {}

export function defineTool<TInput, TOutput>(config: DefineToolConfig<TInput, TOutput>): Tool<TInput, TOutput> {
  return {
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    outputSchema: config.outputSchema,
    version: config.version,
    execute: config.execute,
    permissions: config.permissions,
    timeoutMs: config.timeoutMs,
    retry: config.retry,
    rateLimit: config.rateLimit,
    idempotency: config.idempotency,
    approval: config.approval,
    metadata: config.metadata,
  };
}
