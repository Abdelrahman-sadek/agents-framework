# ADR 019: Production runtime — durable state, queue, workers, recovery

**Status:** Accepted

**Context**

Phase 14 requires durable execution, job recovery, idempotency, persistence and graceful shutdown, without coupling the core to a queue or workflow engine (ADR 008, ADR 013).

**Decision**

1. The durable-execution boundary stays the core's explicit state plus three entry points: `run`, `resume` (approvals) and a new `recover` (continue a `RUNNING` run after a crash). The loop checkpoints **before** executing a model turn's tool calls, so recovery re-invokes exactly the unanswered calls. Tool idempotency keys protect side effects on re-invocation.
2. A new package, `@agent-framework/production`, holds infrastructure adapters:
   - `RunStateStore`s for PostgreSQL (through a minimal `SqlClient` port that `pg.Pool` satisfies, so there is no driver dependency) and SQLite (`node:sqlite`);
   - PostgreSQL audit and idempotency stores;
   - a `JobQueue` port with leases (in-memory, SQLite, PostgreSQL `FOR UPDATE SKIP LOCKED`);
   - `AgentWorker`, `AgentService`, health checks, signal handling, and `createFramework()` with production validation.
3. Delivery is at-least-once. Workers make processing idempotent through run state: no state means run; `RUNNING` means recover; waiting plus a resume job means resume; anything else is acknowledged as a duplicate.
4. Graceful shutdown drains in-flight work and never marks unfinished runs as cancelled. Their leases expire and another worker recovers them.

**Alternatives considered**

- *Queue API inside the core*: rejected (ADR 008).
- *Temporal as the default*: kept optional. Temporal activities can call the same `run`, `resume` and `recover` entry points.
- *Bundling `pg`*: rejected. A structural `SqlClient` keeps drivers an application choice.

**Consequences**

- A crash between the pre-tool checkpoint and the end of a tool call can execute that tool twice without an idempotency key. Tools with side effects should declare one (the tools guide says so).
- A crash during a model call replays that model call (extra cost, no side effects).
- This refines ADR 016: `production` is a new top-level package; the core stays free of infrastructure.
