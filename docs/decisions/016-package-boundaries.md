# ADR 016: Package boundary review

**Status:** Accepted

**Context**

Before Phase 1 implementation, the framework should verify that its package boundaries serve high cohesion, low coupling, and stable public APIs. The goal is not maximum package count.

**Reviewed candidate set**

- core
- runtime
- orchestration
- planning
- context
- memory
- knowledge
- tools
- llm
- security
- observability
- evaluation
- cli

**Decision**

Keep the package set intentionally modest and merged where the responsibility is tightly coupled to the core runtime. The current recommended structure is:

- `@agent-farmework/core`
  - agent definition, agent run, state, events, errors, configuration primitives, fundamental types
  - this package should be the smallest possible stable core
- `@agent-farmework/llm`
  - provider-independent LLM gateway
- `@agent-farmework/tools`
  - tool definition and tool runtime
  - tool runtime depends on core and should coordinate with security/guardrails
- `@agent-farmework/context`
  - context engine
- `@agent-farmework/knowledge`
  - documents, chunking, metadata, embeddings interface, vector store interface, retrieval, citations
- `@agent-farmework/memory`
  - memory stores and memory policies
- `@agent-farmework/orchestration`
  - orchestrator and workers
- `@agent-farmework/security`
  - identity, permissions, policy, guardrails, approvals, audit
- `@agent-farmework/observability`
  - OpenTelemetry integration, cost tracking, run inspection helpers, redaction
- `@agent-farmework/evaluation`
  - datasets and evaluators
- `@agent-farmework/cli`
  - developer CLI

**Merge reasoning**

- `runtime` should **not** be a separate top-level package in the initial structure. The runtime is the composition of core + LLM + tools + context + security + observability, wired together by the framework. Making "runtime" a separate package too early creates an artificial boundary and risks splitting core execution concepts across packages.
- `planning` is intentionally implemented inside `@agent-farmework/orchestration` for now. Planning is an orchestration concern, and separating it too early would add package count without a clear cohesion benefit.
- `cli` stays separate because it is an interface layer with different dependency and deployment concerns.

**What is deliberately not a package**

- provider adapter implementations do not each need their own framework package in the initial structure. They are implementation details behind the interfaces in the relevant package.
- examples, playground, and dashboard remain application-level, not framework packages.

**What would justify adding or splitting a package later**

- a subsystem with a large independent contract
- a subsystem that needs independent version evolution
- a subsystem that should be optionally consumed without bringing in other subsystems

Until those conditions are real, extra packages would most likely be premature.

**Consequences**

- Fewer packages, clearer ownership.
- Core remains small and stable.
- Orchestration and planning are co-located.
- Runtime composition is handled by the framework wiring, not by a dedicated synthetic package.
