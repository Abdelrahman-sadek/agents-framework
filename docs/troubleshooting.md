# Troubleshooting

## Configuration errors (thrown)

| Message | Fix |
| --- | --- |
| `Agent 'x' is not bound to a runtime` | Pass `runtime` to `defineAgent()`, call `runtime.run(agent, …)`, or use `agent.withRuntime(runtime)`. |
| `No LLM provider registered with id 'openai'` | The agent's `model.providerId` must match the `id` of a provider passed to `createRuntime({ providers })`. |
| `declares tools but the runtime has no tool invoker` | Add `tools: new ToolRuntime()` to `createRuntime()`. |
| `Model 'p/m' does not support tool calling` | The provider's `capabilities(modelId).toolCalling` is `false`. Use another model or remove the tools. |
| `duplicate tool name` / `invalid tool name` | Tool names must be unique per agent and match `[A-Za-z0-9_-]{1,64}`. |
| `run 'x' already exists` | Caller-supplied `runId`s must be unique. Use a new id, or read the existing run with `runtime.getState()`. |
| `input schema cannot be converted to JSON Schema` | Avoid Zod features with no JSON Schema form (e.g. transforms on input) or split the tool. |

## Run ended with a status

| Status / code | Meaning | What to do |
| --- | --- | --- |
| `FAILED` · `LIMIT_EXCEEDED` | A limit was hit (`error.metadata.limitType`). | Raise the limit on purpose, or tighten instructions and tools. A model that keeps calling tools is often missing information. |
| `FAILED` · `LLM_ERROR` | The provider failed and retries (if retryable) were exhausted. | Check the `LLM_CALL_FAILED` events. Adapters should mark 429/5xx as `retryable`. |
| `FAILED` · `OUTPUT_VALIDATION_ERROR` | Final answer wasn't valid JSON or failed the `output` schema. | Mention the format in instructions and use a model with structured output. Phase 3 adds automatic correction. |
| `TIMED_OUT` | `timeoutMs` elapsed. | Increase it, or check for slow tools (`TOOL_EXECUTION_*` durations). |
| `CANCELLED` | The caller's `AbortSignal` fired. | Expected if you cancelled. |
| `WAITING_FOR_APPROVAL` | A tool needs a human decision. | Call `agent.resume({ runId, approvals })`. |
| `APPROVAL_EXPIRED` | The approval was decided after `expiresAt`. | Start a new run, or raise `approval.expiresInMs`. |

| `FAILED` · `GUARDRAIL_BLOCKED` | An input or output guardrail blocked content. | Check `GUARDRAIL_TRIGGERED` events for the guardrail and stage. |
| `FAILED` · `VERIFICATION_FAILED` | Verifiers rejected every revision. | Read `error.metadata.failures`. Raise `maxReflectionAttempts` or fix instructions. |
| `FAILED` · `CONTEXT_LIMIT_ERROR` | System prompt + task + last turn exceed the context budget. | Shorten instructions or input, lower `reserveOutputTokens`, or use a larger-context model. |
| `RUNNING` in the store, no worker | The worker died mid-run. | A worker will `recover()` it after the job lease expires, or call `runtime.recover(agent, { runId })`. |

## Orchestration

| Symptom | Cause |
| --- | --- |
| `PLANNING_ERROR … unknown worker` | The planner proposed a worker that does not exist. Improve worker descriptions or use `staticPlanner`. |
| Steps `SKIPPED` | A dependency failed. See `WORKER_FAILED` events. |
| `APPROVAL_REQUIRED` from a worker | An agent worker hit an approval-gated tool. Handle the action in a deterministic worker, or run that agent outside the orchestrator. |
| Delegation fails with `LIMIT_EXCEEDED` | `agentAsTool` depth limit reached. |

## Production

| Symptom | Cause |
| --- | --- |
| `createFramework` throws "Production configuration is incomplete" | Provide durable run state and audit sinks, and a `maxCost` or `maxTokens` budget. |
| Job `failed` with `lastError` | Infrastructure failures exhausted `maxAttempts`. Check the database, then re-enqueue. |
| `node:sqlite` import error | SQLite adapters need Node ≥ 22.5. |

## Tool call problems (the run continues; the step fails)

Look at `result.steps` (`kind: "tool_call"`) and the tool audit log.

| Step error | Cause |
| --- | --- |
| `TOOL_NOT_FOUND` | The model asked for a tool the agent doesn't have. |
| `VALIDATION_ERROR` | Malformed JSON or schema-invalid arguments. The message is returned to the model so it can retry. |
| `TOOL_AUTHORIZATION_ERROR` | Policy denied it. The reason is in the audit record's `authorization.reason` and the `TOOL_AUTHORIZATION_COMPLETED` event, not in the model message. Usually the agent or the user is missing a permission; both need it. |
| `TOOL_TIMEOUT` | The attempt exceeded `timeoutMs`. Timeouts aren't retried unless `retry.retryOnTimeout` is set. |
| `TOOL_ERROR` "Tool 'x' failed" | The tool threw a non-framework exception. See `error.metadata.detail` in the audit record. |
| `TOOL_OUTPUT_INVALID` | The tool returned data that doesn't match its `output` schema. |
| `RATE_LIMITED` | The tool's `rateLimit` window is exhausted. |
| `APPROVAL_REJECTED` | A reviewer declined the call. |

## "My tool is retried when it shouldn't be" / "isn't retried"

Only `FrameworkError`s with `retryable: true` are retried, up to `retry.maxAttempts`. Plain `Error`s are never retried, because retrying an unknown failure could repeat a side effect.

## Tests are flaky around timing

Inject a clock and ids: `createRuntime({ clock, ids: sequentialIds() })`, `new ToolRuntime({ clock })`. Use small `timeoutMs` and `retry.initialDelayMs: 1` in tests.
