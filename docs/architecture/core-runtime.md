## Runtime interface sketch

```typescript
interface AgentRuntime {
  readonly provider: LLMProvider;
  readonly eventEmitter: EventEmitter;
  readonly runIdGenerator: RunIdGenerator;
  readonly clock: Clock;
}

interface EventEmitter {
  emit(event: AgentEvent, agentId: string, actor?: string, correlationId?: string): void;
}

interface RunIdGenerator {
  generate(): string;
}

interface Clock {
  nowISO(): string;
}
```

The runtime is composed explicitly. A minimal Phase 1 runtime looks like:

```typescript
new DefaultAgentRuntime(
  provider,
  eventEmitter,
  runIdGenerator,
  clock
)
```

This keeps the runtime testable and replaceable. It also avoids hidden global state.

## Public API integration

The agent API uses the runtime internally. Developers do not normally construct the runtime directly, but they may provide their own implementations of:

- `EventEmitter`
- `RunIdGenerator`
- `Clock`
- `LLMProvider`

for testing, local customization, or embedded scenarios.

## Durable execution boundary

Phase 1 does not implement full durable execution. It does, however, avoid assumptions that would block later durable execution:

- runs have `runId`, timestamps, status, and events
- execution state is explicit
- the runtime does not assume a single in-process HTTP request owns the run
- approval/blocking is expressed as runtime state and events, not as a side effect

Later phases can introduce:

- an execution/durable-execution abstraction
- implementation adapters for local, PostgreSQL-backed, Redis-backed, and Temporal-backed execution

No queue API is introduced into the core runtime in Phase 1 or Phase 2.

## Reserved extension points

Phase 1 intentionally reserves a small number of extension points so later phases do not have to redesign core interfaces:

- **DecisionProvider / DecisionEngine**: deterministic decisioning separate from LLM reasoning. Future uses include routing, classification, ranking, verification, guard decisions, prompt-injection detection, destructive-action gating, context compaction decisions, and parts of evaluation.
- **ContextManager**: context selection, ranking, deduplication, compression, summarization, token budgeting, and provenance.
- **Tool authorization context**: tool execution must carry user, agent, tenant, tool, and data context so the runtime can decide authoritatively.

These are reserved abstractions. They are not fully implemented yet.

## Determinism again

The runtime is the place where we decide what is deterministic and what is not. That decision is architectural, not incidental.

Deterministic:

- run identity
- state transitions
- limits
- event ordering in the runtime record
- error classification
- retry/timeout behavior for runtime-managed operations

Not deterministic:

- LLM output
- planner/critic suggestions
- retrieval ranking
- optional model-assisted verification

The runtime may use intelligence, but it must not become dependent on intelligence for correctness or authority.

## Review result

Phase 1 passes the review.

- Provider independence is intact.
- Durable execution is not blocked.
- Deterministic decisioning and context management are reserved as extension points.
- Tool runtime is the correct next boundary for Phase 2.
- Skills, sandbox, and model router are documented as future extension points.
- No new hard dependency was introduced for any vendor or infrastructure system.





## Reserved extension points

Phase 1 intentionally reserves a small number of extension points so later phases do not have to redesign core interfaces:

- **DecisionProvider / DecisionEngine**: deterministic decisioning separate from LLM reasoning. Future uses include routing, classification, ranking, verification, guard decisions, prompt-injection detection, destructive-action gating, context compaction decisions, and parts of evaluation.
- **ContextManager**: context selection, ranking, deduplication, compression, summarization, token budgeting, and provenance.
- **Tool authorization context**: tool execution must carry user, agent, tenant, tool, and data context so the runtime can decide authoritatively.

These are reserved abstractions. They are not fully implemented yet.
