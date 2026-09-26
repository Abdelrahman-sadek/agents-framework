# ADR 015: Local embedding strategy for development

**Status:** Accepted

**Context**

The Knowledge subsystem must be provider-independent. For local development and testing, the framework should provide a free or very low-cost embedding option that works on normal developer machines without forcing GPU usage. This option must not constrain the production architecture.

**Decision**

Use a pluggable `EmbeddingProvider` interface, and make the local development default a lightweight embedding option that is practical for developer machines.

For Phase 1 through early phases, the important decision is the interface and the adapter boundary, not the exact local embedding model.

**Local default selection criteria**

- low or zero cost
- runs on typical developer hardware
- does not require GPU by default
- good enough for development and testing
- clearly subordinate to the production embedding path
- easy to swap for another provider

**Practical options considered**

- a local/small embedding model where practical
- a hosted free or low-cost embedding provider used only for development
- a deterministic or synthetic embedding path used strictly for tests and local prototyping

**Recommendation**

For local development, the framework should support a real embedding provider that can run without special hardware, and should allow fast swap to hosted providers. The exact local embedding implementation can be selected later based on ease of setup and licensing, as long as it stays behind the embedding adapter interface.

If a genuinely local embedding model is not pragmatic for all developer machines, the fallback is a hosted low-cost provider used explicitly for development, with the understanding that production should be able to use a different provider.

**What local embedding is not for**

- It is not meant to win accuracy competitions.
- It is not meant to constrain production embedding choices.
- It is not meant to force every developer into a heavy local runtime.

**Consequences**

- Embedding remains an adapter.
- Development can start without enterprise embedding contracts.
- Local embedding choice can be refined later without architectural damage if it stays behind the interface.
