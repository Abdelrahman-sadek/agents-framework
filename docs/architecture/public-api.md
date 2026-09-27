# Public API

Version 0.x. Everything exported from a package's `index.ts` is public. Exports marked `@experimental` may change in a minor release. Anything not exported is internal.

## Simple path

```ts
import { createRuntime, defineAgent } from "@agent-farmework/core";
import { models } from "@agent-farmework/llm";
import { ToolRuntime, defineTool } from "@agent-farmework/tools";

const search = defineTool({ name, description, input, output, execute });
const runtime = createRuntime({ providers: [provider], tools: new ToolRuntime() });
const agent = defineAgent({ name, model: models.openai("…"), instructions, tools: [search], output, runtime });
const result = await agent.run({ input: "Research X" });
```

## `@agent-farmework/core`

| Export | Kind | Purpose |
| --- | --- | --- |
| `defineAgent(config)` | function | Validate and freeze an agent definition |
| `Agent`, `AgentConfig`, `RunOptions`, `ResumeOptions`, `AgentRunResult` | types | Agent surface |
| `createRuntime(options)`, `RuntimeOptions`, `AgentRuntime` | function / types | Explicit runtime composition |
| `FrameworkError` and subclasses, `SerializedError`, `ErrorCategory`, `isRetryable` | classes / types | [Error model](./errors.md) |
| `AgentEvent`, `AgentEventType`, `AgentEventPayloads`, `EventSink`, `EmitFn`, `InMemoryEventSink`, `noopEmit` | types / classes | [Event model](./events.md) |
| `LLMProvider`, `LLMRequest`, `LLMResponse`, `LLMMessage`, `LLMToolCall`, `LLMToolDefinition`, `LLMStreamEvent`, `ModelCapabilities`, `ModelPricing`, `LLMModelSelector`, `estimateCostUsd` | types / function | Provider contract |
| `AgentTool`, `ToolInvoker`, `ToolInvocation`, `ToolInvocationResult`, `ApprovalRequest`, `ApprovalDecision` | types | Tool port |
| `Principal`, `AgentIdentity`, `RunIdentity`, `hasPermission` | types / function | Identity |
| `Schema`, `InferSchema`, `JsonSchema` | types | Validator-agnostic schema contract |
| `AgentState`, `AgentStatus`, `ExecutionStep`, `UsageTotals`, `RunLimits`, `DEFAULT_RUN_LIMITS`, `resolveLimits`, `validateLimits` | types / values | State and limits |
| `RunStateStore`, `InMemoryRunStateStore` | type / class | Persistence port |
| `ContextManager`, `passthroughContext` | type / value | Context port |
| `DecisionEngine`, `DecisionProvider`, `createDecisionEngine`, `ruleDecisionProvider` | types / functions | Decision port |
| `Clock`, `IdGenerator`, `systemClock`, `randomIds`, `sequentialIds` | types / values | Determinism |
| `raceAbort`, `sleep` | functions | Cancellation helpers for adapters |

`@agent-farmework/core/testing`: `createScriptedProvider(steps, options)`, for tests only.

## `@agent-farmework/tools`

| Export | Purpose |
| --- | --- |
| `defineTool(config)`, `Tool`, `AnyTool`, `ToolConfig`, `ToolContext`, `isTool` | Tool definition |
| `ToolRetryPolicy`, `ToolRateLimit`, `ToolIdempotency`, `ToolApproval`, `ToolKind` | Tool options |
| `ToolRuntime`, `ToolRuntimeOptions`, `ExecuteToolOptions`, `ToolExecutionResult`, `hashArguments` | Execution pipeline |
| `permissionPolicy`, `allOf`, `policy`, `decisionPolicy`, `ToolPolicy`, `ToolAuthorizationRequest`, `ToolAuthorizationDecision` | Authorization |
| `AuditSink`, `ToolAuditRecord`, `InMemoryAuditLog` | Audit |
| `IdempotencyStore`, `InMemoryIdempotencyStore`, `RateLimiter`, `InMemoryRateLimiter` | Reliability stores |

## `@agent-farmework/llm`

| Export | Purpose |
| --- | --- |
| `models.openai / anthropic / gemini / openrouter / local / custom` | Serializable model selectors |
| `withFallbacks(primary, …fallbacks)` | `@experimental`: stored, not yet acted on |

## Other packages

| Package | Main exports |
| --- | --- |
| `@agent-farmework/context` | `createContextEngine`, `llmSummarizer`, `approximateTokenCounter` |
| `@agent-farmework/knowledge` | `createKnowledgeBase`, `recursiveChunker`, `fixedSizeChunker`, `htmlToText`, `hashingEmbedder`, `InMemoryVectorStore`, `bm25`, `lexicalReranker` |
| `@agent-farmework/memory` | `createMemory`, `Memory`, `InMemoryMemoryStore`, `DEFAULT_SECRET_PATTERNS` |
| `@agent-farmework/orchestration` | `defineOrchestrator`, `defineWorker`, `staticPlanner`, `llmPlanner`, `validatePlan`, `agentAsTool`, `supervisor`, `runPipeline`, `runParallel`, `agentVerifier` |
| `@agent-farmework/security` | guardrails (`piiGuardrail`, `promptInjectionGuardrail`, `secretLeakGuardrail`, `contentPolicyGuardrail`, `maxLengthGuardrail`), policies (`rbacPolicy`, `abacPolicy`, `tenantIsolationPolicy`, `dataClassificationPolicy`), `createEgressPolicy`, `safeFetch`, `defineHttpTool`, `envSecrets`, `principalFromClaims` |
| `@agent-farmework/observability` | `openTelemetrySink`, `logSink`, `redactingSink`, `fileEventSink`, `readEventFile`, `CostTracker`, `inspectRun`, `formatRunReport`, `createDashboardServer` |
| `@agent-farmework/evaluation` | `skillDataset`, `defineDataset`, `defineEvaluation`, `evaluators`, `formatReport`, `compareReports` |
| `@agent-farmework/production` | `PgVectorStore`, `PostgresMemoryStore`, `RedisRateLimiter`, `RedisIdempotencyStore`, `createFramework`, `AgentWorker`, `AgentService`, run-state stores, job queues, `createHealthCheck`, `installGracefulShutdown`, `openSqlite` |
| `@agent-farmework/provider-anthropic` | `anthropicProvider`, `ANTHROPIC_MODELS` |
| `@agent-farmework/mcp` | `mcpTools`, `connectStdioServer`, `connectHttpServer` |
| `@agent-farmework/sandbox` | `workspaceTools`, `commandTool`, `confine`, `localProcessRunner` |
| `@agent-farmework/cli` | `runCli`, `defineAgentFromManifest`, `parseManifest`, `checkManifest` (+ `agent` binary) |

Core additions since Phase 2: `agent.stream`, `StreamCallbacks`, `defineSkill`, approval `modified` / `escalated` decisions, `runtime.recover` / `agent.recover`, `ContextProvider` / `ContextItem`, `Guardrail`, `Verifier` with `ruleVerifier` / `citationVerifier` / `llmCritic`, `EmbeddingProvider`, `createEventEmitter`, `createRuleProvider` (testing).

## Configuration levels

| Level | Where | Examples |
| --- | --- | --- |
| Framework | `createRuntime()`, `new ToolRuntime()` | providers, sinks, stores, policy, default limits |
| Agent | `defineAgent()`, `defineTool()` | model, instructions, tools, permissions, limits, tool timeouts |
| Run | `agent.run()` | input, user, run id, metadata, limit overrides, signal |

See [Configuration](./configuration.md).

## Changes from the Phase 1 draft

- `DefaultAgentRuntime` class → `createRuntime()` factory. `agent.run()` works when the agent is bound to a runtime.
- `defineTool({ inputSchema, outputSchema, timeout })` → `defineTool({ input, output, timeoutMs })`.
- `Tool` permissions are a list of required permission strings, not allow/deny lists. Allow/deny logic belongs in policies.
- Events renamed (`LLMCALL_*` → `LLM_CALL_*`, `TOOLCALL_*` → `TOOL_*`) and wrapped in envelopes.
