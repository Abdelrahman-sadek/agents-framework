# Implementation roadmap

Implementation proceeds phase by phase. Each phase should reach its own quality gates before the next phase begins.

## Phase 0 — Architecture

Completed.

Delivered:

- architecture
- ADRs
- threat model
- data model
- execution lifecycle
- developer API proposal
- package structure
- roadmap
- open decisions and risks

Minimal scaffolding only.

## Phase 1 — Core runtime

**Completed.**

Delivered:

- `defineAgent()`, `createRuntime()`, and the run loop with explicit, serializable `AgentState`
- typed, sequenced event model with isolated sinks
- `FrameworkError` hierarchy with codes, categories, retryability and correlation ids
- provider-independent LLM contract with capability metadata (locality, context window, pricing, latency, data classes)
- limits: steps, tool calls, tokens, cost, timeout, model retries; cancellation through `AbortSignal`
- ports: `LLMProvider`, `ToolInvoker`, `RunStateStore`, `ContextManager`, `DecisionEngine`, `Clock`, `IdGenerator`
- `@agent-framework/core/testing` scripted provider; `@agent-framework/llm` model selectors

Phase 1 review outcome (Phase 2 prompt §1–8): no vendor, database, queue, telemetry or protocol is imported by the core; the durable-execution boundary is `RunStateStore` + explicit state; decision engine, context, capability metadata, skills and sandbox extension points are in place or documented ([extension points](./architecture/extension-points.md)).

## Phase 2 — Tool system

**Completed.**

Delivered:

- `defineTool()` with Zod input/output schemas and JSON Schema generation
- `ToolRuntime`: parse → validate → authorize → approval → rate limit → idempotency → concurrency → execute (timeout, retry, backoff) → validate output → audit
- deterministic policies (`permissionPolicy`, `allOf`, `policy`, `decisionPolicy`), fail-closed
- human approval bound to call id and argument hash, with expiry; pause/resume through run state
- tool lifecycle events, audit records with redaction
- unit, integration and security tests; `hello-agent` and `approval-agent` examples
- [ADR 017](./decisions/017-decision-engine.md), [ADR 018](./decisions/018-tool-system.md)

Known limitations carried forward:

- stores (state, audit, idempotency, rate limit) are in-memory only
- approval "modify" and "escalate" are not implemented
- no streaming in the run loop; no provider fallback/routing yet
- HTTP, MCP and sandbox adapters are designed, not built

## Phase 3 — Structured outputs

**Next.** Basic parse-and-validate already ships with Phase 1; Phase 3 adds the correction loop, JSON Schema response formats, output events and typed failure records.

Implement:

- schema-based outputs
- validation
- retry/correction
- typed results

Quality gates:

- unit tests
- example

## Phase 4 — Context engine

Planned.

Implement:

- context assembly
- token budgets
- message management
- summarization
- context policies

Quality gates:

- unit tests
- example

## Phase 5 — Knowledge / RAG

Planned.

Implement:

- documents
- chunking
- metadata
- embeddings
- retrieval
- metadata filtering
- citations
- vector store abstraction

Quality gates:

- integration tests
- example

## Phase 6 — Memory

Planned.

Implement:

- short-term state
- conversation memory
- long-term memory
- semantic/episodic memory
- memory policies

Quality gates:

- unit tests
- integration tests where applicable

## Phase 7 — Planning

Planned.

Implement:

- planner
- plans
- steps
- dependencies
- re-planning
- execution state

Quality gates:

- unit tests
- example

## Phase 8 — Reflection

Planned.

Implement:

- verification
- critic
- rule-based verification
- source verification
- correction loop

Quality gates:

- unit tests
- example

## Phase 9 — Orchestration

Planned.

Implement:

- orchestrator
- workers
- parallel execution
- sequential execution
- dependencies
- failure recovery

Quality gates:

- unit tests
- example

## Phase 10 — Multi-agent

Planned.

Implement:

- agent-to-agent communication
- supervisor
- worker agents
- delegation
- shared/isolated context policies

Quality gates:

- unit tests
- example

## Phase 11 — Security

Planned.

Implement:

- identity
- RBAC
- permissions
- tenant isolation
- guardrails
- prompt injection defenses
- audit logs

Quality gates:

- security review
- unit and security-focused tests
- example

## Phase 12 — Observability

Planned.

Implement:

- OpenTelemetry
- tracing
- metrics
- logs
- cost tracking
- run inspection

Quality gates:

- tracing tests
- example

## Phase 13 — Evaluation

Planned.

Implement:

- dataset
- evaluators
- regression tests
- agent evaluation
- tool evaluation
- RAG evaluation
- safety evaluation

Quality gates:

- evaluation tests
- example

## Phase 14 — Production

Planned.

Implement:

- persistence
- queues
- durable execution
- recovery
- rate limiting
- circuit breakers
- health checks
- deployment documentation

Quality gates:

- integration tests
- operational review
- example
- deployment docs

## Cross-cutting rules

- No phase is complete if tests are failing.
- Each phase should include at least one example where applicable.
- Each phase should update docs where behavior changes.
- Each phase should consider backward compatibility for public API changes.
- Security and observability concerns continue through later phases, not just Phase 11 and Phase 12.
