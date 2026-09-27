# Configuration

Configuration has three levels. Each is validated when it is created, and invalid configuration throws a `ConfigurationError` immediately (fail fast).

## 1. Framework — `createRuntime()` and `new ToolRuntime()`

```ts
const runtime = createRuntime({
  providers: [openai, anthropic, ollama],       // required, unique ids
  tools: new ToolRuntime({
    policy: allOf(permissionPolicy({ requireUser: true }), tenantPolicy),
    audit: postgresAudit,
    idempotency: redisIdempotency,
    rateLimiter: redisRateLimiter,
    defaultTimeoutMs: 20_000,
  }),
  events: [otelSink, logSink],
  stateStore: postgresRunStore,
  context: contextEngine,                        // Phase 4
  limits: { maxSteps: 12, timeoutMs: 180_000 },  // framework defaults
  retry: { initialDelayMs: 250, maxDelayMs: 4_000 },
  clock, ids,
  onSinkError: (err, event) => log.warn({ err, type: event.type }),
});
```

Secrets such as API keys belong in provider adapters, loaded from your secret manager. They are never part of agent definitions, prompts or state.

## 2. Agent — `defineAgent()` and `defineTool()`

Model, instructions, tools, the agent's permissions, output schema, default limits and model settings. For tools: schemas, required permissions, timeout, retry, rate limit, concurrency, idempotency, approval and sensitivity.

## 3. Run — `agent.run()`

Input, user principal, optional run id, metadata, limit overrides and an abort signal. `resume()` accepts approvals, a signal and a new `timeoutMs`. Other limits are fixed when the run starts.

## Limit precedence

`DEFAULT_RUN_LIMITS` → `createRuntime({ limits })` → `defineAgent({ limits })` → `run({ limits })`. Later layers override earlier ones field by field. The resolved limits are stored in `AgentState.limits`.

## Environments

The runtime behaves the same in development, test and production. What changes is the adapters you inject:

| Concern | Development / test | Production |
| --- | --- | --- |
| Model | `createScriptedProvider`, local model | cloud or self-hosted adapter |
| Run state | `InMemoryRunStateStore` | durable store (PostgreSQL/Redis/Temporal-backed) |
| Tool audit | `InMemoryAuditLog` | append-only store / SIEM |
| Idempotency, rate limits | in-memory | shared store (e.g. Redis) |
| Events | `InMemoryEventSink`, console | OpenTelemetry bridge, log pipeline |
| Ids, clock | `sequentialIds()`, fixed clock | `randomIds`, `systemClock` |

A declarative agent manifest (YAML) and environment-aware `createFramework()` configuration are planned with the CLI ([roadmap](../roadmap.md)).
