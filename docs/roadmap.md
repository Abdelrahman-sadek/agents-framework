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

In progress.

Implemented:

- agent definition
- agent runtime
- agent execution
- agent state types
- event system
- error system
- configuration primitives
- basic LLM provider abstraction

Examples and tests:

- `examples/hello-agent` uses the public API
- unit tests for errors, events, LLM types, run limits
- integration tests for agent runtime with mock LLM

Quality gates:

- TypeScript compile
- lint
- unit tests
- integration tests
- example

Phase 1 acceptance criteria:

- a developer can define and run an agent with the public API
- the runtime emits `AgentStarted`, `LLMCallStarted`, `LLMCallCompleted`, and `AgentCompleted` / failure events
- the execution has `runId`, `agentId`, timestamps, status, error handling, cancellation support where practical, and configurable limits

## Phase 2 — Tool system

Planned.

Implement:

- tool definition
- schema validation
- execution
- permissions
- timeout
- retry
- audit events

Quality gates:

- TypeScript compile
- lint
- unit tests
- integration tests where applicable
- example

## Phase 3 — Structured outputs

Planned.

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
