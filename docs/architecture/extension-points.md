# Extension points

The core stays small by defining interfaces for everything that varies. This page lists them: what exists now, and what later phases will plug in.

| Port | Implementations |
| --- | --- |
| `LLMProvider` | `anthropicProvider` (official SDK), `openAICompatibleProvider`, wrappers `withCircuitBreaker` / `withRateLimit` / `withFallback`, test providers |
| `ToolInvoker` | `ToolRuntime` |
| `ToolPolicy` | `permissionPolicy`, `allOf`, `policy`, `decisionPolicy`, `rbacPolicy`, `abacPolicy`, `tenantIsolationPolicy`, `dataClassificationPolicy` |
| `AuditSink`, `IdempotencyStore`, `RateLimiter` | in-memory; `PostgresAuditSink`, `PostgresIdempotencyStore` |
| `EventSink` | `InMemoryEventSink`, `openTelemetrySink`, `logSink`, `redactingSink`, `fileEventSink`, `CostTracker` |
| `RunStateStore` | in-memory, `SqliteRunStateStore`, `PostgresRunStateStore` |
| `JobQueue` | in-memory, `SqliteJobQueue`, `PostgresJobQueue` |
| `ContextManager` / `ContextProvider` | `passthroughContext`, `createContextEngine`; knowledge and memory providers |
| `EmbeddingProvider`, `VectorStore`, `Reranker` | `hashingEmbedder`, `InMemoryVectorStore`, `lexicalReranker` |
| `MemoryStore` | `InMemoryMemoryStore` |
| `Guardrail` | PII, prompt injection, secret leak, content policy, max length |
| `Verifier` | `ruleVerifier`, `citationVerifier`, `llmCritic`, `agentVerifier` |
| `DecisionEngine` / `DecisionProvider` | `createDecisionEngine`, `ruleDecisionProvider` |
| `SecretProvider` | `envSecrets` |
| `SandboxRunner` | `localProcessRunner` (container/VM runners are adapters) |
| `Skill` | `defineSkill` |
| MCP | `mcpTools`, `connectStdioServer`, `connectHttpServer` |
| `Schema` | any `safeParse` validator (Zod) |
| `Clock`, `IdGenerator` | system, random, sequential |

## Decision engine

Many choices in an agent system are *decisions*: routing, classification, ranking, verification, guard checks, prompt-injection detection, gating destructive actions, context compaction and evaluation. They shouldn't all be pushed into one prompt.

```ts
interface DecisionProvider {
  id: string;
  deterministic: boolean;              // same input → same decision, no model call
  supports(kind: DecisionKind): boolean;
  decide(request: DecisionRequest): Decision | Promise<Decision>;
}
// Decision = { verdict: "allow" | "deny" | "abstain", value?, confidence?, reason?, providerId }

const engine = createDecisionEngine({ providers: [rules, localClassifier], deterministicOnly: false });
```

- Deny overrides allow. A provider that throws counts as deny (fail closed).
- `deterministicOnly: true` rejects non-deterministic providers at construction. Security callers use this: `decisionPolicy(engine)` for tool authorization refuses LLM judges outright.
- Possible providers: deterministic rules, local models, an external engine adapter (for example Jev) or an LLM judge. None is a dependency of the core.

## Context manager

Every model request goes through `ContextManager.assemble({ messages, maxTokens })`, so no code path assumes the whole transcript fits. Phase 4 implements selection → ranking → deduplication → compression → summarization → token budgeting → provenance behind this port. The authoritative transcript stays in `AgentState`, and the context manager only decides what the model sees.

## Model capabilities and routing

`ModelCapabilities` carries locality (`cloud`/`local`), context window, max output, tool calling, structured output, streaming, vision, embeddings, pricing, latency and allowed data classifications. A future model router picks a model from *task requirements + capabilities + cost + latency + locality + hardware*, and can refuse models that may not process a given data class. `LLMModelSelector.fallbacks` is reserved for it.

## Skills

Implemented: see [Skills](../skills.md) and [ADR 022](../decisions/022-skills-mcp-sandbox.md).

## Sandbox tools

Implemented: see [Sandbox tools](../sandbox.md). Isolation beyond the local process is a `SandboxRunner` adapter.

## Tool adapters and MCP

HTTP, database, filesystem, sandbox and MCP integrations are adapters that **produce `defineTool` tools**. MCP is a protocol integration, not the internal tool model ([ADR 010](../decisions/010-mcp-integration.md)). An MCP server's tools pass through the same `ToolRuntime` pipeline.

## Adopting external projects

The framework owns its abstractions. External projects (local inference, agent runtimes, memory, evaluation, MCP, sandboxing, durable execution, AI security, decision systems) can inspire adapters, but before a dependency is added it is evaluated on:

1. maturity, 2. maintenance activity, 3. license, 4. security posture, 5. architecture fit, 6. performance, 7. community, 8. lock-in risk, 9. API stability, 10. whether it solves a real framework problem.

Nothing is added because it is trending. Runtime dependencies today: **zod** (packages that define schemas), **@opentelemetry/api** (observability, API only), **@anthropic-ai/sdk** (only `provider-anthropic`) and **@modelcontextprotocol/sdk** (only `mcp`). The core has none.
