# Architecture

> **Implementation map.** Every component below is implemented. Core runtime, LLM contract, reflection and guardrail hooks: `@agent-farmework/core`. LLM gateway: `@agent-farmework/llm` + `provider-anthropic`. Tool runtime: `@agent-farmework/tools`. Context engine: `@agent-farmework/context`. Knowledge: `@agent-farmework/knowledge`. Memory: `@agent-farmework/memory`. Planning, orchestration, multi-agent: `@agent-farmework/orchestration`. Security and guardrails: `@agent-farmework/security`. Observability: `@agent-farmework/observability`. Evaluation: `@agent-farmework/evaluation`. Persistence and execution/durability: `@agent-farmework/production`. Guides: [docs index](../README.md).

## 1. Purpose and scope

The framework is a **runtime + intelligence separation** layer. It makes deterministic software responsible for execution, state, permissions, persistence, observability, and cost control. It makes LLMs responsible for judgment, reasoning, extraction, planning hints, and verification where appropriate.

The framework is **not**:

- a prompt library
- a chatbot UI framework
- a single application agent
- a vendor-specific SDK

The framework is:

- a set of provider-independent interfaces
- a controlled execution runtime
- a strongly typed configuration and state model
- an auditable, observable agent execution substrate

## 2. High-level system architecture

```
Application
    │
    ▼
Frameworks API surface
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

## 3. Execution model

The framework distinguishes two execution paths:

- **direct agent run** for simple requests that fit in one agent execution
- **orchestrated run** for planning, worker delegation, verification, or multi-agent workflows

Both paths share the same runtime core, the same state model, and the same observability and security boundaries.

## 4. Component architecture

### 4.1 LLM Gateway

The LLM gateway is provider-independent. It normalizes message formats, streaming, tool calling, structured outputs, token usage, errors, retries, timeouts, rate limits, and fallback behavior.

It does **not** own:

- authorisation
- billing decisions
- prompt content policy
- tool authorization

It does own:

- provider adaptation
- request normalization
- response normalization
- telemetry metadata
- failure classification

### 4.2 Tool Runtime

Tools are first-class framework primitives. The tool runtime validates, authorizes, executes, protects, observes, and audits tool calls.

Tool execution flow:

```
LLM requests an action
    │
    ▼
Framework validates request
    │
    ▼
Authorization
    │
    ▼
Guardrails
    │
    ▼
Tool execution
    │
    ▼
Result validation
    │
    ▼
Audit
```

**Implemented in Phase 2** (`@agent-farmework/tools`). The concrete pipeline is parse → validate input → authorize → approval → rate limit → idempotency → concurrency → execute (timeout, retry) → validate output → audit. Guardrails plug in at the authorization step as `ToolPolicy`s until the Phase 11 guardrail engine arrives. See the [Tools guide](../tools.md) and [ADR 018](../decisions/018-tool-system.md).

### 4.3 Context Engine

Context is not "send everything to the model". The context engine selects, prioritizes, budgets, summarizes, and assembles context from:

- system instructions
- agent instructions
- user input
- conversation history
- relevant memories
- relevant knowledge
- tool results
- current task state
- prior execution state
- summaries

Selection is governed by relevance, priority, and token budget.

### 4.4 Memory

Memory is separate from knowledge. It includes short-term state, conversation memory, user memory, entity memory, episodic memory, and semantic memory. Memory is policy-driven: it is not blindly persisted.

### 4.5 Knowledge / RAG

Knowledge supports documents, chunking, metadata, embeddings, vector/hybrid search, filtering, reranking, and citation tracking. The reference implementation is PostgreSQL + pgvector.

### 4.6 Planning

Planning produces structured, observable plans with explicit steps, dependencies, status, worker assignment, inputs, outputs, timeout, and retry policy. The runtime, not the LLM, owns the execution graph.

### 4.7 Reflection / Verification

Reflection is a first-class capability. It can use schema validation, rule validation, tool-based verification, source verification, deterministic checks, LLM-based critics, or cross-agent verification. Reflection is configurable and limited.

### 4.8 Orchestration

The orchestrator manages tasks, plans, workers, dependencies, parallelism, sequencing, failure handling, retries, timeouts, re-planning, and final aggregation. Workers are isolated and permission-limited.

### 4.9 Security

Security is a core subsystem, not a naming convention. It includes identity, authorization, RBAC/ABAC, tenant isolation, secret management, tool and data permissions, audit, prompt-injection defense, SSRF protection, rate limiting, and resource limits.

### 4.10 Observability

Observability is OpenTelemetry-native. It traces agent runs, LLM calls, tool calls, retrieval, memory operations, workers, reflection, and final outputs. It records latency, errors, token usage, estimated cost, model, tool usage, retry count, context size, retrieval results, and state transitions. Sensitive data is redacted by policy.

### 4.11 Persistence

Persistence stores execution state, tool calls, approvals, memory operations, retrievals, LLM calls, and events. It supports reconstruction of what happened, when, why, which agent, which user, which tools, which model, which data, which permissions, which failures, and which retries.

### 4.12 Execution / Durability

Durable execution is abstracted behind a runner interface. The core is queue-agnostic. Runners may be:

- a local durable runner backed by SQLite
- a Redis-backed execution/queue runner
- a PostgreSQL-backed persistence runner
- a Temporal or other durable workflow engine adapter

## 5. Runtime architecture

The runtime is composed of layered, pluggable subsystems.

```
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

Runtime guarantees:

- state is explicit and persisted
- permissions are enforced deterministically
- tool calls cannot bypass the tool runtime
- LLM output is validated and may be corrected
- every execution is traceable
- sensitive data is never blindly logged

## 6. Data flow

### 6.1 Agent run data flow

1. request arrives with user, agent, tenant, and run context
2. input guardrails run
3. policy engine authorizes the run
4. context is assembled
5. memory and knowledge are selected
6. optional planning produces a plan
7. execution proceeds by steps, tools, and/or workers
8. outputs are validated and optionally reflected
9. final output passes output guardrails
10. run state, events, and telemetry are persisted

### 6.2 Tool execution data flow

1. tool call request is produced by the agent/runtime
2. request is validated against tool schema
3. authorization checks the caller identity, permissions, and data permissions
4. guardrails evaluate the request and intended action
5. tool executes with timeout, retries, and rate limits
6. result is validated
7. tool call event is recorded
8. audit entry is produced

## 7. Lifecycles

### 7.1 Agent execution lifecycle

```
INITIALIZED
    │
    ▼
GUARDRAILS_INPUT
    │
    ▼
AUTHORIZED
    │
    ▼
CONTEXT_ASSEMBLED
    │
    ▼
PLANNING_OPTIONAL
    │
    ▼
EXECUTING
    │
    ▼
REFLECTING_OPTIONAL
    │
    ▼
GUARDRAILS_OUTPUT
    │
    ▼
COMPLETED
    │
    ▼
PERSISTED_AND_OBSERVED
```

Possible terminal states also include:

- `FAILED`
- `CANCELLED`
- `TIMEOUT`
- `WAITING_FOR_APPROVAL`
- `APPROVAL_REJECTED`
- `APPROVAL_EXPIRED`

### 7.2 Tool execution lifecycle

```
TOOL_REQUESTED
    │
    ▼
VALIDATED
    │
    ▼
AUTHORIZED
    │
    ▼
GUARDRAILED
    │
    ▼
EXECUTING
    │
    ▼
RESULT_VALIDATED
    │
    ▼
COMPLETED
```

Tool execution can also fail with timeout, rejection, or error states.

As implemented, these states are observable as events: `TOOL_REQUESTED` → `TOOL_AUTHORIZATION_STARTED/COMPLETED` → optional `TOOL_APPROVAL_*` → `TOOL_EXECUTION_STARTED` → `TOOL_EXECUTION_COMPLETED | FAILED | TIMED_OUT`. See [Events](./events.md).

### 7.3 Planning lifecycle

```
TASK_RECEIVED
    │
    ▼
PLAN_GENERATED
    │
    ▼
PLAN_VALIDATED
    │
    ▼
STEPS_SCHEDULED
    │
    ▼
STEP_EXECUTING
    │
    ▼
STEP_COMPLETED_OR_FAILED
    │
    ▼
REPLANNING_IF_NEEDED
    │
    ▼
PLAN_COMPLETED
```

### 7.4 Reflection lifecycle

```
OUTPUT_GENERATED
    │
    ▼
VALIDATION_STRATEGIES_APPLIED
    │
    ▼
VERIFIED_OR_FLAGGED
    │
    ▼
CORRECTION_IF_NEEDED
    │
    ▼
FINAL_OUTPUT_OR_FAILURE
```

Reflection is capped by `maxAttempts` and only used where configured.

### 7.5 Orchestration lifecycle

```
TASK_ASSIGNED
    │
    ▼
PLAN_ADAPTED_TO_WORKERS
    │
    ▼
WORKERS_SCHEDULED
    │
    ▼
WORKERS_RUNNING
    │
    ▼
DEPENDENCIES_RESOLVED
    │
    ▼
RESULTS_AGGREGATED
    │
    ▼
VERIFICATION_IF_NEEDED
    │
    ▼
ORCHESTRATION_COMPLETED
```

### 7.6 Human approval lifecycle

```
ACTION_PROPOSED
    │
    ▼
APPROVAL_REQUESTED
    │
    ▼
WAITING_FOR_APPROVAL
    │
    ▼
APPROVED
    │
    ▼
ACTION_EXECUTED
    │
    ▼
COMPLETED
```

Alternate paths:

- `REJECTED`
- `EXPIRED`
- `CANCELLED`
- `ESCALATED`

Pending approvals survive process restarts because approval state is persisted.

## 8. Multi-tenancy overview

Execution state can associate:

- `tenantId`
- `organizationId`
- `userId`
- `agentId`
- `runId`

Tenant isolation is supported as a first-class concept. It is not assumed to be solvable only at the application layer.

## 9. Provider independence principle

Core components use interfaces and adapters. No core package hard-codes a single vendor for:

- LLM providers
- embedding providers
- vector stores
- storage
- queue/execution systems
- observability
- authentication
- memory stores

This is the foundation for avoiding vendor lock-in and for enterprise portability.
