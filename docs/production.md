# Production

`@agent-farmework/production` turns the runtime into a durable service:

```
API → AgentService.submit() → durable queue → AgentWorker → runtime.run/resume/recover → RunStateStore
```

Long-running work never depends on an HTTP request staying open.

## Configuration

```ts
import pg from "pg";
import { createFramework, PostgresRunStateStore, PostgresAuditSink, PostgresIdempotencyStore, PostgresJobQueue } from "@agent-farmework/production";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });   // any client with query(text, params)
const runs = new PostgresRunStateStore(pool); await runs.migrate();
const audit = new PostgresAuditSink(pool); await audit.migrate();

const { runtime, tools } = createFramework({
  environment: "production",
  llm: { providers: [withCircuitBreaker(anthropicProvider())] },
  persistence: { runs },
  tools: { audit, idempotency: new PostgresIdempotencyStore(pool), policy: rbacPolicy({ roles }) },
  observability: { sinks: [openTelemetrySink(), redactingSink(logSink())] },
  limits: { maxCost: 0.5, maxTokens: 200_000, timeoutMs: 300_000 },
});
```

`createFramework` validates the configuration and fails fast. In `production` it refuses in-memory run state or audit, and it refuses to start without a spend budget. `development` and `test` accept in-memory defaults.

## Queue, workers, service

```ts
const queue = new PostgresJobQueue(pool); await queue.migrate();     // FOR UPDATE SKIP LOCKED; SqliteJobQueue for single node
const service = new AgentService({ queue, runtime, agents: ["support"] });
const worker = new AgentWorker({ queue, runtime, agents: [supportAgent], concurrency: 4, leaseMs: 60_000 });
worker.start();
installGracefulShutdown(() => worker.stop({ timeoutMs: 30_000 }));

// HTTP handlers
await service.submit("support", { input, user, runId: requestId });   // idempotent with a caller-supplied id
await service.status(runId);                                          // QUEUED / RUNNING / WAITING_FOR_APPROVAL / COMPLETED …
await service.approve(runId, [{ approvalId, decision: "approved", decidedBy }]);
```

## Failure model

| Failure | Handling |
| --- | --- |
| Model timeout, 429, 5xx | Runtime retries with backoff (`maxLLMRetries`); `withCircuitBreaker`, `withFallback`, `withRateLimit` at the gateway |
| Tool failure | Per-tool timeout, retry for retryable errors, idempotency keys |
| Malformed model output | Tool-argument validation, output schema correction loop |
| Worker crash | The job lease expires, another worker leases it; state is `RUNNING`, so it calls `runtime.recover()`, which re-invokes unanswered tool calls from the checkpoint taken before side effects, then continues |
| Duplicate delivery | The job is acknowledged as a duplicate when state is already terminal or waiting |
| Database failure | Job retried with exponential backoff, then marked `failed` |
| Process shutdown | Stop leasing, drain in-flight jobs; leases of unfinished jobs expire and are recovered elsewhere |

Temporal or another workflow engine can drive the same `run` / `resume` / `recover` entry points ([ADR 013](./decisions/013-temporal-durable-execution.md)); the core has no dependency on it.

## Shared stores

| Store | Class | Notes |
| --- | --- | --- |
| Vector search | `PgVectorStore(client, { dimensions })` | pgvector HNSW (cosine), tenant visibility and metadata filters in SQL; pass as `createKnowledgeBase({ store })` |
| Memory | `PostgresMemoryStore(client)` | Pass as `createMemory({ store })`; authorization stays in `Memory` |
| Rate limits | `RedisRateLimiter(redis)` | Fixed window shared across instances |
| Idempotency | `RedisIdempotencyStore(redis)` or `PostgresIdempotencyStore(client)` | Shared across instances |

`redis` is anything with `get`, `set`, `incr` and `pexpire` (for example ioredis). Every PostgreSQL class has `migrate()`.

## Operations

- `createHealthCheck({ db: () => pool.query("select 1"), queue: ..., model: { check: ping, critical: false } })` → `ok | degraded | down`.
- Retention: `PostgresRunStateStore.deleteOlderThan(date)` for terminal runs, `memory.purgeExpired()`, and `forget()` for data deletion.
- SQLite (`openSqlite`, `SqliteRunStateStore`, `SqliteJobQueue`) gives durable single-node and development setups with no extra services (Node ≥ 22.5).
