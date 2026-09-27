# ADR 017: Decision engine extension point

**Status:** Accepted (interface only)

**Context**

Routing, classification, ranking, verification, guard decisions, prompt-injection detection, destructive-action gating, context compaction and evaluation are decisions. If the only tool is "ask the LLM in the prompt", every one of them becomes non-deterministic, costly and hard to audit, and security-relevant decisions end up depending on a model.

**Decision**

Add a `DecisionEngine` / `DecisionProvider` abstraction to `@agent-farmework/core`:

- providers declare `deterministic` and which `DecisionKind`s they support;
- the engine combines providers with deny-overrides and fails closed when a provider throws;
- `deterministicOnly` rejects non-deterministic providers at construction;
- security callers (`decisionPolicy` for tool authorization) require deterministic providers and treat `abstain` as deny.

No concrete engine (Jev or otherwise) is a dependency. Implementations are adapters.

**Alternatives considered**

- *Hooks per feature* (a guard hook, a router hook…): simpler at first, but each feature reinvents combination, fail-closed and audit semantics.
- *LLM-only decisions*: rejected. They conflict with the deterministic-core principle.

**Consequences**

- Future guardrails, routing and verification can share one mechanism and one audit story.
- Only the interface and a rule-based helper exist today, so real providers must be built per phase.
