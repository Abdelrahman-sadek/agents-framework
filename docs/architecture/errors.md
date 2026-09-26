# Error architecture

Errors must be consistent, inspectable, retry-aware, and correlated with execution. They should separate developer mistakes from runtime failures from provider/tool/infrastructure failures.

## Error contract

Framework errors should expose:

```typescript
interface FrameworkError {
  code: string;
  message: string;
  cause?: unknown;
  retryable: boolean;
  metadata?: Record<string, unknown>;
  runId?: string;
  stepId?: string;
  toolCallId?: string;
  llmCallId?: string;
}
```

## Error categories

### Developer errors

Errors caused by incorrect use of the framework, such as invalid configuration or invalid agent definition.

- should be clear
- usually not retryable
- often detected early

### Validation errors

Errors from schema or output validation failures.

- often retryable in the sense that the framework may re-attempt structured output or correction
- should record what failed validation

### Provider errors

Errors from LLM providers or embedding providers.

- may be retryable
- should be normalized
- should include provider, model, and outcome metadata where useful

### Tool errors

Errors from tool execution.

- may reflect timeout, failure, rejection, authorization, or approval gating
- should distinguish internal tool failure from blocked action

### Authorization errors

Errors from permission or policy denial.

- not retryable by retrying the same request
- should be explicit about what was denied

### Execution errors

Errors from the runtime itself, such as step failure, cancellation, timeout, or budget exceeded.

- should include run context
- should distinguish transient failure from terminal failure

### Infrastructure errors

Errors from persistence, queues, or external systems the framework depends on.

- may be retryable
- should be separable from logical failures

### Policy violations

Guardrail blocks and policy denials.

- should be explicit and auditable
- should not rely on the LLM asserting whether something is allowed

## Error hierarchy

The framework should have a small, clear error taxonomy, for example:

- `FrameworkError`
  - `AgentError`
  - `ToolError`
  - `LLMError`
  - `ValidationError`
  - `AuthorizationError`
  - `ContextLimitError`
  - `MemoryError`
  - `KnowledgeError`
  - `PlanningError`
  - `ExecutionError`
  - `ApprovalRequiredError`
  - `PolicyViolationError`
  - `InfrastructureError`

The exact hierarchy can be refined during Phase 1, but the separation of concerns should remain.

## Retry semantics

Retryability should be explicit, not implied.

- Some errors are transient and retryable.
- Some are terminal.
- Some require human intervention.
- Some require configuration correction.

The runtime should not blindly retry everything.

## Error metadata

Useful metadata includes:

- error code
- provider or tool name
- model where relevant
- retry count
- timeout
- budget used
- relevant ids

Error metadata should not include sensitive data unless explicitly required and sanitized.

## Correlation

Every non-trivial error should be traceable to:

- runId
- agentId
- stepId where applicable
- toolCallId or llmCallId where applicable

This is essential for debugging and audit.
