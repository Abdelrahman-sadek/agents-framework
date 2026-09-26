# Public API proposal

This is the Version 0 public API proposal. It is intentionally split into a simple common case and composable advanced configuration.

## Design goal

A normal developer should be able to write:

```typescript
const agent = defineAgent({
  name: "research-agent",
  model,
  instructions: `You are a research assistant.`,
  tools: [searchTool],
  output: ResearchReportSchema,
});

const result = await agent.run({
  input: "Research current weather trends",
});
```

Enterprise developers should be able to extend the same surface without making simple cases noisy:

```typescript
const agent = defineAgent({
  name: "research-agent",

  model,
  instructions: `You are a research assistant.`,

  tools: [searchTool],

  output: ResearchReportSchema,

  planning: planning.adaptive(),
  reflection: reflection.verify(),
  memory: memory.user(),
  knowledge: knowledge.base("company-documents"),

  security: {
    permissions: ["knowledge.read", "database.read"],
  },

  guardrails: {
    input: [injectionGuard, piiGuard],
    output: [restrictedTopicGuard],
  },

  limits: {
    maxSteps: 20,
    maxTokens: 20000,
    maxCost: 0.50,
    timeout: "5m",
  },
});
```

## Design rules

- Simple API should not require advanced configuration.
- Advanced configuration should be composable objects, not a flat super-config.
- Agent identity and capabilities should be declared, not inferred from prompt content.
- Output typing should be explicit.
- Run-time behavior should be overridable per run, but defaults should be declared per agent.

## Core definitions

### defineAgent

```typescript
declare function defineAgent<TOutput = unknown>(
  config: DefineAgentConfig<TOutput>
): Agent<TOutput>;
```

`DefineAgentConfig`:

```typescript
interface DefineAgentConfig<TOutput = unknown> {
  name: string;
  model: LLMModelSelector;
  instructions?: string | PromptTemplate;
  system?: string | PromptTemplate;

  tools?: Tool[];
  knowledge?: KnowledgeConfig;
  memory?: MemoryConfig;
  planning?: PlanningConfig;
  reflection?: ReflectionConfig;

  security?: SecurityConfig;
  guardrails?: GuardrailConfig;
  context?: ContextConfig;

  output?: Schema<TOutput>;

  limits?: RunLimits;
  execution?: ExecutionConfig;
  observability?: ObservabilityConfig;

  decisionProvider?: DecisionProvider;
  contextManager?: ContextManager;
}
```

### defineTool

```typescript
declare function defineTool<TInput, TOutput>(
  config: DefineToolConfig<TInput, TOutput>
): Tool<TInput, TOutput>;
```

`DefineToolConfig`:

```typescript
interface DefineToolConfig<TInput, TOutput> {
  name: string;
  description: string;
  inputSchema: Schema<TInput>;
  outputSchema?: Schema<TOutput>;

  execute: ExecuteToolHandler<TInput, TOutput>;

  permissions?: ToolPermissions;
  timeout?: Duration;
  retry?: RetryPolicy;
  idempotencyKey?: IdempotencyStrategy;
  approvals?: ApprovalConfig;
}
```

### defineWorker

Workers are isolated execution participants with limited tools and permissions.

```typescript
declare function defineWorker<TInput, TOutput>(
  config: DefineWorkerConfig<TInput, TOutput>
): Worker<TInput, TOutput>;
```

Worker configs declare name, instructions, model, tools, limits, and permissions.

### defineOrchestrator

Orchestrators coordinate workers, dependencies, sequencing, parallelism, aggregation, and optional re-planning.

```typescript
declare function defineOrchestrator(config: DefineOrchestratorConfig): Orchestrator;
```

### definePlanner

Planners produce structured plans from a task.

```typescript
declare function definePlanner(config: DefinePlannerConfig): Planner;
```

Planners are composable and can be swapped per agent.

### defineGuardrail

Guardrails are applied to input or output.

```typescript
declare function defineGuardrail(config: DefineGuardrailConfig): Guardrail;
```

Guardrails can be deterministic, schema-based, policy-based, or model-assisted, but deterministic controls remain authoritative where relevant.

### defineEvaluation

```typescript
declare function defineEvaluation(config: DefineEvaluationConfig): Evaluation;
```

Evaluations are built from datasets and evaluators.

## Models/provider access

The public API should expose providers through a stable selector/adapter surface rather than raw SDK imports.

For example:

```typescript
const model = models.openai("gpt-4o");
const model = models.anthropic("claude-sonnet-4-20250514");
const model = models.openrouter("...");
const model = models.custom(myAdapter);
```

Model selection should support capabilities, fallback, and cost metadata without exposing provider internals in the agent API.

## Output typing

Output schemas are first-class.

```typescript
const ResearchReportSchema = z.object({
  summary: z.string(),
  findings: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});
```

The framework should return typed output after validation and optional correction.

## Run configuration

Run configuration is separate from agent configuration.

```typescript
interface RunConfig<TInput = unknown> {
  input: TInput;
  metadata?: Record<string, unknown>;
  limits?: RunLimits;
  contextOverrides?: ContextOverrides;
  signal?: AbortSignal;
}
```

Common run limits:

```typescript
interface RunLimits {
  maxSteps?: number;
  maxToolCalls?: number;
  maxTokens?: number;
  maxCost?: number;
  timeout?: Duration;
  maxRetries?: number;
  maxReflectionAttempts?: number;
}
```

## Event and error access

Advanced users should be able to observe execution through events and typed errors, but these should not clutter the simple path.

```typescript
const result = await agent.run(...);
// result may also expose:
// - runId
// - status
// - steps
// - events
// - errors
// - token usage and estimated cost
```

## Version 0 scope

Version 0 public API is intentionally limited to:

- agent definition
- tool definition
- model selection
- output schemas
- run configuration and limits
- observable events and typed errors

It does **not** require a full implementation of memory, knowledge, planning, reflection, orchestration, security, or evaluation in Phase 1. Those capabilities should integrate into this API when they exist.

Version 0 also reserves:

- `decisionProvider`
- `contextManager`

for later phases, so deterministic decisioning and advanced context management can be added without changing the simple API.

## Non-goals for Version 0

- Full multi-agent orchestration
- Full persistence layer
- Full security/authorization runtime
- Full evaluation platform
- Full production queue/durable execution backend

These can be added later behind the same API shapes where appropriate.

## Naming stability

- The public API names above are preferred, but exact names may still be refined during Phase 1 implementation.
- Any breaking public API change after freeze should go through an ADR.
