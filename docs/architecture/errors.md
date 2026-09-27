# Errors

All runtime errors are `FrameworkError`s:

```ts
class FrameworkError extends Error {
  code: string;                 // stable, machine-readable
  category: ErrorCategory;      // developer | validation | provider | tool | authorization | execution | infrastructure | policy
  retryable: boolean;
  metadata: Record<string, unknown>;
  runId?: string; stepId?: string; toolCallId?: string; llmCallId?: string;
  cause?: unknown;              // kept in-process, never serialized
  toJSON(): SerializedError;
}
```

Errors are serialized with `toJSON()` before they reach a result, an event, persisted state or a model message, so causes and stacks don't leak. `FrameworkError.from(value, fallback)` normalizes anything thrown.

## Codes

| Class | Code | Category | Retryable |
| --- | --- | --- | --- |
| `ConfigurationError` | `CONFIGURATION_ERROR` | developer | never |
| `ValidationError` | `VALIDATION_ERROR` | validation | no (option) |
| `OutputValidationError` | `OUTPUT_VALIDATION_ERROR` | validation | no (option) |
| `LLMError` | `LLM_ERROR` | provider | option |
| `ToolError` | `TOOL_ERROR` | tool | option |
| `ToolTimeoutError` | `TOOL_TIMEOUT` | tool | no (see `retryOnTimeout`) |
| — | `TOOL_OUTPUT_INVALID` | tool | no |
| `ToolNotFoundError` | `TOOL_NOT_FOUND` | validation | never |
| `AuthorizationError` | `AUTHORIZATION_ERROR` | authorization | never |
| `ToolAuthorizationError` | `TOOL_AUTHORIZATION_ERROR` | authorization | never |
| `ApprovalRequiredError` | `APPROVAL_REQUIRED` | policy | never |
| `ApprovalRejectedError` | `APPROVAL_REJECTED` | policy | never |
| `ApprovalExpiredError` | `APPROVAL_EXPIRED` | policy | never |
| `RateLimitError` | `RATE_LIMITED` | policy | yes (default) |
| `LimitExceededError` | `LIMIT_EXCEEDED` | policy | never |
| `PolicyViolationError` | `POLICY_VIOLATION` | policy | never |
| `CancellationError` | `CANCELLED` | execution | never |
| `RunTimeoutError` | `RUN_TIMEOUT` | execution | never |
| `AgentError` | `AGENT_ERROR` | execution | option |
| `ExecutionError` | `EXECUTION_ERROR` | execution | option |
| `InfrastructureError` | `INFRASTRUCTURE_ERROR` | infrastructure | yes (default) |
| `ContextLimitError`, `MemoryError`, `KnowledgeError`, `PlanningError` | reserved | — | option |

"option" means the thrower decides with `{ retryable }`. "never" classes ignore the option.

## Where errors surface

| Situation | Surface |
| --- | --- |
| Developer mistake (bad config, unknown provider, missing tool runtime, duplicate run id) | **thrown** from `defineAgent`, `createRuntime`, `run`, `resume` |
| Run-level failure (provider error after retries, limits, output validation, cancellation, timeout) | `result.status` + `result.error` |
| Tool-level failure (invalid args, denial, timeout, tool error, rejection) | failed `ExecutionStep` + tool message to the model; the run continues |

## Retry rules

- Model calls: `retryable` errors are retried up to `maxLLMRetries` with exponential backoff.
- Tool calls: `retryable` errors are retried up to `retry.maxAttempts`. Plain exceptions are wrapped as non-retryable `TOOL_ERROR`.
- Cancellation, timeouts, authorization and validation errors are never retried.
