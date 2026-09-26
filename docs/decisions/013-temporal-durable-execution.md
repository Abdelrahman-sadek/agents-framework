# ADR 013: Temporal and durable execution evaluation

**Status:** Accepted

**Context**

Agent execution in production must be durable: it must survive crashes, long waits, human approvals, retries, timers, and distributed execution. The framework should not hard-code one queue or workflow engine into the core. Instead, it should define a durable execution/workflow abstraction and provide adapters.

This ADR evaluates four candidate directions:

1. Temporal
2. Redis + custom execution runtime
3. PostgreSQL + custom durable execution
4. TypeScript-native workflow/queue approach

It then records the recommended default topology.

**Evaluation dimensions**

- crash recovery
- long-running agents
- human approval pauses
- retries
- timers
- scheduled execution
- distributed workers
- exactly-once vs at-least-once semantics
- idempotency
- workflow versioning
- horizontal scaling
- operational complexity
- local development experience
- testing
- cost
- TypeScript developer experience
- enterprise adoption
- lock-in

**Option 1: Temporal**

Strengths:

- battle-tested durable execution semantics
- strong workflow replay model
- timers, signals, updates, retries, and human-in-the-loop patterns are first-class
- polyglot and widely used in enterprise environments

Weaknesses and trade-offs:

- operational complexity is real, especially self-hosted; managed Temporal reduces but does not eliminate it
- long-lived workflows require discipline around event history size and Continue-as-New
- payloads and history have limits that matter for large agent state
- worker model is durable, but it is also a deployment and lifecycle surface
- for serverless or "just an HTTP endpoint" deployments, the worker model is a heavier fit than HTTP-step engines
- adopting Temporal commits the deployment to another platform in practice, even if it remains an adapter in code

Fit for this framework:

- strong candidate for orchestrated, long-running, enterprise agent workflows
- less ideal as the only execution model for simple runs, local dev, and low-infra deployments

**Option 2: Redis + custom execution runtime**

Strengths:

- common, practical, and familiar
- good for queues, locks, rate limiting, and ephemeral state
- can be made durable enough for many agent scenarios with careful design

Weaknesses and trade-offs:

- Redis is often treated as durable, but the durability story depends heavily on configuration and operational choices
- building temporal semantics on top of Redis is not free
- human-approval pauses, timers, and crash recovery require extra engineering beyond a basic queue
- exactly-once is not automatic; idempotency must be explicit

Fit for this framework:

- strong middle path for many production deployments
- good fit when teams already run Redis and want queue-based execution without a full workflow platform
- should be an adapter, not the durability model by itself

**Option 3: PostgreSQL + custom durable execution**

Strengths:

- aligns with the framework's production database choice
- durable and transactional
- enables checkpoint-based recovery and observability through SQL
- removes a separate orchestration tier in many deployments
- strong fit for enterprise environments already using PostgreSQL

Weaknesses and trade-offs:

- database-backed coordination can become a bottleneck at very high scale if not designed carefully
- workflow versioning, replay, timers, and long waits must be designed explicitly
- horizontal scaling needs queue/dequeue and locking/concurrency design
- does not automatically provide Temporal-style workflow replay semantics unless the framework builds them

Fit for this framework:

- very strong default when PostgreSQL is already the production database
- especially attractive for durable agent execution where persistence and audit are already required
- practical and lower-lock-in than adopting a separate workflow platform for many use cases

**Option 4: TypeScript-native workflow/queue approach**

Strengths:

- maximum control
- low external dependency surface for the execution model
- can be tailored closely to agent lifecycle semantics

Weaknesses and trade-offs:

- durability, crash recovery, timers, and distributed coordination are hard to get right
- easy to underdeliver relative to real durable workflow engines
- "queue-like" systems often fail to provide true workflow semantics unless extra work is invested
- should be judged by durable workflow capabilities, not by ease of initial implementation

Fit for this framework:

- acceptable as a local dev or lightweight execution path
- not a strong default if the goal is robust durable workflow semantics across production deployments
- acceptable when implemented intentionally as a real checkpoint-based durable runtime, not as a thin queue wrapper

**Recommendation**

The framework's core should be built around durable workflow semantics, not around a queue API.

Recommended topology:

```
Core
  ↓
Execution / Workflow abstraction
  ↓
Adapters
  ├── Local durable runner
  ├── PostgreSQL-backed durable runner
  ├── Redis-based runner
  └── Temporal adapter
```

Default recommendations:

- **Local development:** a local durable runner. SQLite is acceptable for local/dev/testing. This is an implementation detail of the local runner, not the conceptual foundation.
- **Default production path for many deployments:** PostgreSQL-backed durable execution, because it aligns with the production database, supports checkpointing and audit, and reduces operational surface. This should be a first-class adapter.
- **Redis-based runner:** a strong optional production path when a deployment already relies on Redis and wants queue-based execution.
- **Temporal adapter:** a strong optional production path for teams that need Temporal's workflow semantics, long-running workflow discipline, and enterprise orchestration features. It should remain an adapter, not a core dependency.

Why this recommendation:

- It keeps the core execution model durable and abstract.
- It avoids choosing a custom queue merely because it is easier to implement.
- It gives teams a practical default (PostgreSQL-backed durable execution) without ruling out Temporal for cases where Temporal is the better fit.
- It preserves the adapter boundary required by the architecture.

**Notes and open questions**

- The exact durable semantics of each adapter must be documented explicitly: what survives a crash, what survives a restart, what constitutes a checkpoint, how timers work, how approvals pause execution, and how retries behave.
- At-least-once execution with idempotency is the pragmatic default for many systems; exactly-once should be treated as a strong invariant where supported and as idempotency-plus-dedup elsewhere.
- Workflow versioning needs an explicit strategy before long-running agent workflows are relied upon in production.
