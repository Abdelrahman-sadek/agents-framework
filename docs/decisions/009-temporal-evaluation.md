# ADR 009: Temporal evaluation

**Status:** Proposed for evaluation in Phase 0; recommendation pending finalization

**Context**

Durable execution is one of the hardest parts of an enterprise agent framework. Temporal is one candidate for that role. The framework should evaluate it honestly rather than adopt it by default or reject it by assumption.

**What is being evaluated**

The framework should compare:

- Temporal
- TypeScript-native queue/workflow implementation
- Redis-based queue plus the framework's own runtime

**Evaluation dimensions**

- durability
- crash recovery
- long-running workflows
- retries
- timers
- human approval pauses
- distributed execution
- developer experience
- operational complexity
- cost
- scalability
- TypeScript ecosystem fit
- vendor/platform lock-in

**Architectural constraint**

Temporal is not to be made a hard dependency of the core. Even if it is adopted for some deployments, the core should keep the execution adapter boundary.

**Expected tradeoffs**

- **Temporal**: strong durability and workflow primitives, but introduces platform/operational dependency and changes operational model.
- **TypeScript-native implementation**: maximum control and lower external dependency, but more engineering burden for durable state, timers, crashes, and recovery.
- **Redis + framework runtime**: practical middle ground for many deployments, but still requires careful 설계 around durability, semantics of waits, and failure modes.

**What Phase 0 should produce**

- a documented comparison of the three options
- a recommendation for the default production path and default local path
- a clear statement that the core remains execution-adapter-agnostic

**Current leaning**

Local development should use a simple durable runner. Production should support multiple backends through the adapter. The final recommendation should be documented after the evaluation is complete.

**Open questions**

- Which deployments are expected to need distributed durable execution versus single-process durable execution?
- How much of the framework's own execution semantics should be implemented in the runtime versus delegated to the underlying engine?
- Which durability guarantees are acceptable for the default local runner?
