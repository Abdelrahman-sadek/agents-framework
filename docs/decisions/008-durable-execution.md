# ADR 008: Durable execution as an abstracted runtime capability

**Status:** Accepted

**Context**

Agent execution in production cannot depend on a single long-lived HTTP request. It must support queues, persistence, retries, long-running tasks, timers, human approval pauses, crash recovery, and distributed execution. The framework should support these without coupling the core runtime to one specific queue or workflow engine.

**Decision**

Keep the core runtime execution/workflow interface agnostic.

Conceptually:

```
Agent Runtime
      │
      ▼
Execution / Workflow Interface
      │
 ┌────┼───────────────┐
 ▼    ▼               ▼
Local  Redis          Temporal
Runner Adapter        Adapter
```

The core defines the abstraction. Runners implement it.

**Local development**

A simple local durable runner may use SQLite, with `better-sqlite3` preferred where native modules are acceptable. SQLite is an implementation detail for the local runner, not the foundation of durable execution.

**Production**

Production can use:

- Redis-backed execution/queue
- PostgreSQL-backed persistence
- Temporal or another durable workflow engine
- other adapter implementations

**Design rules**

- The core does not own the queue or workflow engine.
- The execution model is expressed in terms of state, checkpoints, retries, timers, and approvals.
- The runner adapts the framework's execution model to the underlying system.

**Alternatives considered**

- Hard-coding one queue technology into the core
- Treating in-memory execution as sufficient for production
- Making durable execution an afterthought in a later phase

**Consequences**

- The framework can run locally with low overhead.
- Production can scale and choose the execution backbone that fits operational needs.
- The durable execution abstraction must be well-defined, because it becomes the contract between the runtime and any queue/workflow engine.
- If the abstraction is too narrow, later adapters will be awkward; if too broad, it becomes a workflow engine itself.
