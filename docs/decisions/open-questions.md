# Open decisions and risks

This document tracks unresolved decisions and architectural risks after Phase 14.

## Open decisions

### Package identity and npm scope

The repository uses `@agent-farmework/*` as the working internal convention. Publication naming is not finalized until npm availability is checked explicitly.

Status: pending external verification before publish.

### Durable execution default for production

Phase 0 recommends a PostgreSQL-backed durable runner as a strong default, with Redis and Temporal as optional adapters. The exact default for production may still be refined based on deployment assumptions.

Status: documented direction; implementation deferred.

### Temporal adapter priority

Temporal is recommended as an optional adapter, not a core dependency. The order in which adapters are implemented in later phases is still open.

Status: adapter boundary is the binding decision.

### Local embedding default

The local embedding default is intentionally deferred to a real adapter behind the `EmbeddingProvider` interface. The exact model can be chosen later without architectural damage.

Status: interface is the binding decision.

### Observability verbosity

Console/local export defaults must be tuned so development is useful without leaking sensitive data.

Status: open tuning decision.

### CLI command set

The initial CLI command set is defined conceptually. Exact command names, flags, and behavior may be refined during implementation.

Status: likely stable conceptually; detail pending.

### Multi-tenancy in early examples

Early examples may not need multi-tenancy, but the framework must eventually demonstrate it.

Status: framework support required; examples may start simpler.

### Package boundary adjustments during Phase 1

The current package set is intentionally modest. If Phase 1 implementation reveals a better split, boundaries may be adjusted before later phases.

Status: Phase 1–2 kept the 11-package layout. One refinement: the LLM provider contract lives in `core` and `llm` holds selectors and future gateway features ([ADR 018](./018-tool-system.md)). Unimplemented packages are private placeholders.

### Approval modification and escalation

Approving with modified arguments, and escalating to another reviewer, are part of the target lifecycle but not implemented. A modified action must currently be a new tool call.

Status: open; revisit with the durable approval store (Phase 14) or security phase (Phase 11).

### Shared stores for multi-instance deployments

Idempotency, rate-limit and audit stores ship as in-memory implementations. Multi-instance deployments need shared adapters (PostgreSQL/Redis).

Status: PostgreSQL audit and idempotency stores exist; Redis adapters and a pgvector store are still planned.

## Risks

### R1: Interface creep

If the abstraction set grows too broad before implementation, interfaces may become awkward or over-generalized.

Mitigation: prefer cohesive boundaries, implement early phases, and revise interfaces based on real usage.

### R2: Provider normalization burden

Normalizing LLM providers is real work and may surface gaps in streaming, tool calling, structured output, and error models.

Mitigation: implement the LLM gateway early and document capability differences honestly.

### R3: Security drift

As features are added, security controls can be diluted if they are not enforced continuously.

Mitigation: keep security review in every phase and treat the tool runtime and policy engine as critical trust boundaries.

### R4: Durable execution complexity

Durable execution is hard. If the abstraction is too narrow, adapters will be awkward; if too broad, the framework may accidentally reimplement a workflow engine.

Mitigation: define the contract carefully and keep the core decoupled from any one backend.

### R5: Cost and unbounded behavior

Without limits, agent execution can become expensive and unpredictable.

Mitigation: budget, token limits, step limits, retry caps, and stop conditions must be first-class.

### R6: Data leakage through telemetry

Telemetry is valuable, but prompts, tool arguments, documents, and user data must not be logged blindly.

Mitigation: enforce redaction policies and treat telemetry privacy as a production requirement.

### R7: RAG retrieval quality

Retrieval can degrade agent quality quickly if it returns too much irrelevant content.

Mitigation: implement relevance filtering, metadata filtering, hybrid search, reranking, and citation tracking deliberately.

### R8: Memory policy discipline

Blindly saving everything creates noise, cost, and governance problems.

Mitigation: make memory policy-driven and explicit about TTL, scope, ownership, and provenance.

### R9: Reflection overuse

Reflection can improve quality but also increase cost and latency.

Mitigation: make reflection configurable and bounded.

### R10: Vendor lock-in via adapters

Even with provider independence, adapter implementations can be incomplete or uneven.

Mitigation: keep core contracts clean and treat adapter-specific behavior as adapter-local when possible.

## Recommendations for next steps

All 14 phases are implemented; remaining work is tracked in the [roadmap](../roadmap.md#next). Priorities:

- Streaming through the run loop and adapters.
- Shared-store adapters (pgvector, Redis) for multi-instance deployments.
- MCP and sandbox tool adapters.
- Finalize package identity, then publish 0.x.
