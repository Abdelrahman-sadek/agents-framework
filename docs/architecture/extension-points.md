# Extension points

The core stays small by defining interfaces for everything that varies. This page lists them: what exists now, and what later phases will plug in.

| Port | Status | Implementations today | Planned |
| --- | --- | --- | --- |
| `LLMProvider` | ✅ | `createScriptedProvider` (tests) | OpenAI, Anthropic, Gemini, OpenRouter, OpenAI-compatible local servers |
| `ToolInvoker` | ✅ | `ToolRuntime` | — |
| `ToolPolicy` | ✅ | `permissionPolicy`, `allOf`, `policy`, `decisionPolicy` | RBAC/ABAC policy engine (Phase 11) |
| `AuditSink`, `IdempotencyStore`, `RateLimiter` | ✅ | in-memory | PostgreSQL, Redis |
| `EventSink` | ✅ | `InMemoryEventSink` | OpenTelemetry bridge, log sinks (Phase 12) |
| `RunStateStore` | ✅ | `InMemoryRunStateStore` | SQLite, PostgreSQL, Redis; Temporal runner (Phase 14) |
| `ContextManager` | 🧩 | `passthroughContext` | Context engine (Phase 4) |
| `DecisionEngine` / `DecisionProvider` | 🧩 | `createDecisionEngine`, `ruleDecisionProvider` | local classifiers, external engines, LLM judges |
| `Schema` | ✅ | any `safeParse` validator (Zod) | — |
| `Clock`, `IdGenerator` | ✅ | system, random, sequential | — |

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

A **Skill** will be a composable, testable capability, not a prompt string:

```ts
// Future shape (not implemented)
defineSkill({
  name, description,
  input: Schema, output: Schema,
  instructions,                 // scoped, not appended to a giant system prompt
  tools: [..],                  // required tools
  permissions: [..],            // union checked like tool permissions
  dependsOn: [otherSkill],
  examples: [..],
  evaluation: { dataset, evaluators },
});
```

The current design already accommodates it: agents take `tools: AgentTool[]` and `permissions`, tools carry their own schemas and permissions, and instructions are plain data. A skill can compile down to a set of tools, permissions and an instruction fragment without changing the runtime.

## Sandbox tools

Filesystem, shell, git, network and workspace access will be **sandbox-backed tools** (`kind: "sandbox"`). The sandbox adapter owns isolation and resource limits (CPU, memory, wall time, egress allow-list), and each capability is a separate, narrowly scoped tool with its own permissions and approval rules. A model never receives raw OS authority; it gets tools like `read_file(path)` inside a workspace root, subject to the same validation, policy, approval and audit as every other tool.

## Tool adapters and MCP

HTTP, database, filesystem, sandbox and MCP integrations are adapters that **produce `defineTool` tools**. MCP is a protocol integration, not the internal tool model ([ADR 010](../decisions/010-mcp-integration.md)). An MCP server's tools pass through the same `ToolRuntime` pipeline.

## Adopting external projects

The framework owns its abstractions. External projects (local inference, agent runtimes, memory, evaluation, MCP, sandboxing, durable execution, AI security, decision systems) can inspire adapters, but before a dependency is added it is evaluated on:

1. maturity, 2. maintenance activity, 3. license, 4. security posture, 5. architecture fit, 6. performance, 7. community, 8. lock-in risk, 9. API stability, 10. whether it solves a real framework problem.

Nothing is added because it is trending. Phase 2 added one runtime dependency, **zod** (tools only), and the core has none.
