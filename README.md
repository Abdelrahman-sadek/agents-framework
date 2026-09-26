# Enterprise AI Agent Framework

A production-grade, extensible framework for building reliable AI agents on **Node.js + TypeScript**.

The framework gives application developers a standardized runtime for LLM fundamentals, tool calling, structured outputs, context management, RAG/knowledge, memory, planning, reflection, orchestration, multi-agent systems, guardrails, security, observability, evaluation, and production durability — without reinventing that infrastructure for every agent.

> **Current status:** Phase 0 — architecture, decisions, threat model, data model, developer-API proposal, and roadmap. Runtime implementation begins in Phase 1 after review and approval.

## What this framework is

- A **provider-independent** agent runtime for Node.js and TypeScript
- A **deterministic runtime** layered under LLM intelligence
- A **strongly typed** set of abstractions with runtime schema validation
- An **auditable, observable** execution substrate for enterprise use
- A **modular monorepo** designed for multiple teams and multiple agents

## What this framework is not

- A chatbot UI framework
- A single application-specific agent
- A vendor-specific LLM SDK
- A thin wrapper around another framework

## Design principles

- **Runtime vs. intelligence separation.** LLMs are used for judgment, reasoning, extraction, and optional verification. Deterministic software owns state, permissions, execution, retries, persistence, budgets, observability, and audit.
- **Provider independence.** The core uses interfaces and adapters for LLM providers, embedding providers, vector stores, storage, execution/queue backends, observability, authentication, and memory stores.
- **Explicit state.** Agent runs, steps, tool calls, approvals, memory operations, retrievals, LLM calls, and events are first-class and reconstructable.
- **Strong typing and runtime validation.** TypeScript types guide development, but runtime validation protects real trust boundaries.
- **Deterministic security.** Authorization, permissions, audit, and policy are enforced by the runtime, never by “the LLM says it is allowed.”
- **Simple defaults, advanced escape hatches.** Basic agents should be easy. Enterprise patterns should be possible without forcing every developer to understand the entire stack immediately.
- **Cost and budget awareness.** Token usage, estimated cost, retries, limits, and budgets are treated as production concerns.
- **OpenTelemetry-native observability.** No proprietary tracing system.

## Repository layout

```text
packages/
  core/            Core abstractions, agent definition, execution model, state, events, errors, configuration
  llm/             Provider-independent LLM gateway
  tools/           Tool definition, validation, execution runtime, permissions, retry, audit
  context/         Context engine, token budgets, message management, summarization, context policies
  knowledge/       Documents, chunking, metadata, embeddings, vector store, hybrid retrieval, reranking, citations
  memory/          Short-term, conversation, user, entity, episodic, semantic memory
  orchestration/   Orchestrator, workers, dependencies, parallel/sequential execution, recovery
  security/        Identity, RBAC/ABAC, tenant isolation, guardrails, policy engine, approvals, audit
  observability/   OpenTelemetry tracing, metrics, logs, cost tracking, run inspection, redaction
  evaluation/      Datasets, evaluators, regression tests, LLM-as-judge, deterministic evaluation, reports
  cli/             Developer CLI: init, dev, test, evaluate, inspect, trace

apps/
  examples/        Realistic agent examples
  playground/      Interactive exploration surface
  dashboard/       Run inspection and observability UI (future)

docs/
  architecture/    System, component, runtime, data flow, and lifecycle docs
  decisions/       Architectural Decision Records (ADRs)
  security/        Threat model, trust boundaries, controls
  concepts/        Core framework concepts
  examples/        Example walkthroughs
```

## Stack

- TypeScript with strict configuration
- ESM architecture
- pnpm monorepo
- Zod for runtime schema validation
- PostgreSQL for production persistence
- SQLite for local development and testing
- PostgreSQL + pgvector as the reference vector store
- OpenTelemetry for observability
- Pluggable LLM, embedding, vector store, storage, execution, observability, and storage providers
- Commander-based developer CLI

## High-level architecture

```text
Application
    │
    ▼
Agent Framework
    │
    ▼
Agent Runtime
    │
    ├── LLM Gateway
    ├── Tool Runtime
    ├── Context Engine
    ├── Memory
    ├── Knowledge / RAG
    ├── Planner
    ├── Reflection / Verification
    ├── Orchestration
    ├── Security / Policy
    ├── Guardrails
    ├── Observability
    ├── Persistence
    └── Execution / Durability
```

Runtime layered model:

```text
Agent Run
    │
    ├── Identity + Context
    ├── Guardrails (input)
    ├── Permissions / Policy
    ├── Context Assembly
    ├── Memory + Knowledge selection
    ├── LLM Gateway
    ├── Tool Runtime
    ├── Reflection / Verification
    ├── Orchestration when needed
    ├── Persistence
    ├── Observability
    └── Guardrails (output)
```

## Developer API (target shape)

The eventual public API is meant to feel simple at the call site and powerful underneath.

### Define a tool

```typescript
import { defineTool } from "@agent-framework/core";
import { z } from "zod";

const weatherTool = defineTool({
  name: "get_weather",
  description: "Get current weather for a city",
  inputSchema: z.object({
    city: z.string(),
  }),
  execute: async ({ city }) => {
    // ... tool logic
    return { city, temperatureCelsius: 18, condition: "partly cloudy" };
  },
});
```

### Define an agent

```typescript
import { defineAgent } from "@agent-framework/core";
import { models } from "@agent-framework/llm";

const researchAgent = defineAgent({
  name: "research-agent",
  model: models.openai("model"),
  instructions: `You are a research agent.`,
  tools: [weatherTool],
});
```

### Run an agent

```typescript
const result = await researchAgent.run({
  input: "Research current conditions",
});
```

### Deeper configuration

The same model supports advanced enterprise capabilities without forcing every developer to use them:

```typescript
const researchAgent = defineAgent({
  name: "research-agent",

  model: models.openai("model"),

  instructions: `You are a research agent.`,

  tools: [searchTool, databaseTool],

  knowledge: knowledge.base("documents"),

  memory: memory.user(),

  planning: planning.adaptive(),

  reflection: reflection.verify(),

  security: {
    permissions: ["knowledge.read", "database.read"],
  },

  output: ResearchReportSchema,
});
```

### Lifecycle targets

The framework models explicit lifecycles for:

- **agent runs**
- **tool execution**
- **planning**
- **reflection / verification**
- **orchestration / workers**
- **human approval**
- **durable execution**

### Human approval example

```text
Agent
  │
  ▼
Proposed Action
  │
  ▼
Human Approval
  │
  ▼
Tool Execution
```

Approval state is persisted so that pauses survive restarts.

## Persistence and durability model

- **Production persistence:** PostgreSQL
- **Local development persistence:** SQLite
- **Durable execution:** abstracted behind a runner interface

Production can use different execution backends through adapters:

```text
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

The core does not hard-code one queue or workflow engine.

## Knowledge and memory model

- **Memory** is separated from **knowledge**.
- Memory supports short-term state, conversation memory, user memory, entity memory, episodic memory, and semantic memory.
- Memory is policy-driven with TTL, scope, ownership, provenance, and lifecycle control.
- **Knowledge/RAG** supports documents, parsing, chunking, metadata, embeddings, vector/hybrid search, filtering, reranking, and citation tracking.
- PostgreSQL + pgvector is the reference vector store, with a provider-independent vector store interface.

## Security posture

Security is a core subsystem, not an add-on.

- Authorization uses a combined identity model:
  - user identity
  - agent identity
  - tenant context
  - tool permission
  - data permission
- The policy engine makes the final authorization decision.
- The LLM is never trusted as the authorization authority.
- Multi-tenancy is supported as a first-class concept.
- Guardrails cover input and output.
- Prompt injection, SSRF, credential exposure, data leakage, tenant isolation, malicious documents, and supply-chain risks are considered explicit attack surfaces.
- Audit logging is part of the runtime model.

## Observability

The framework uses OpenTelemetry.

Tracked execution includes:

- agent runs
- LLM calls
- tool calls
- retrieval
- memory operations
- workers
- reflection
- final output
- cost and token usage
- retry count
- context size
- state transitions

Sensitive data is redacted according to configurable policies. Prompts, tool arguments, documents, and user data are not assumed safe for telemetry.

## Evaluation

The framework includes an evaluation subsystem for:

- golden datasets
- regression testing
- LLM-as-judge
- deterministic evaluators
- tool-use evaluation
- retrieval evaluation
- safety evaluation
- cost and latency evaluation

Example shape:

```typescript
const evaluation = defineEvaluation({
  dataset,
  agent,
  evaluators: [correctness, groundedness, toolAccuracy, safety],
});
```

## CLI

The developer CLI is built with Commander and is an interface to the framework, not the framework itself.

```bash
agent init
agent dev
agent test
agent evaluate
agent inspect
agent trace
```

CLI dependencies are isolated from the runtime.

## Documentation

- [Architecture](./docs/architecture/README.md)
- [Lifecycles](./docs/architecture/lifecycles.md)
- [Data flow](./docs/architecture/data-flow.md)
- [Decisions (ADRs)](./docs/decisions/README.md)
- [Security](./docs/security/README.md)
- [Concepts](./docs/concepts/README.md)
- [Examples](./docs/examples/README.md)

## License

Apache-2.0

## Phase 0 scope

Phase 0 delivers:

- repo scaffolding and monorepo structure
- architecture documentation
- decisions (ADRs)
- threat model and security controls
- target developer API proposal
- data model and execution state model
- lifecycle documentation
- implementation roadmap through Phase 14
- open decisions and risks

Phase 0 does **not** implement the full runtime yet. After Phase 0 is approved, implementation proceeds one phase at a time with tests, typecheck, lint, docs, and examples at each step.

## Roadmap

Phases are tracked in:

- [Implementation roadmap](./docs/roadmap.md)
- [Open decisions and risks](./docs/decisions/open-questions.md)

## Contributing

This project is currently in early architecture phase. Changes to core abstractions, interface contracts, and public API shape should go through ADR review when they are significant.
