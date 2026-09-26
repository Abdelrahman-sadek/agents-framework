# Data flow

## Request flow

Every agent run starts from a request that includes more than just the user prompt. A request should carry:

- user identity
- agent identity
- tenant/org context
- intended permissions or requested action scope
- input payload
- optional configuration overrides
- correlation/run id

The request enters the runtime, not directly into an LLM call.

## Context assembly flow

Context assembly is a filtering and budgeting step.

```
Available information
    │
    ▼
Relevance
    │
    ▼
Priority
    │
    ▼
Token budget
    │
    ▼
Final model context
```

Context sources:

- system instructions
- agent instructions
- user input
- conversation history
- memories
- knowledge results
- tool results
- current task state
- prior execution state
- summaries

Context is assembled according to a context policy, which may include:

- max tokens
- whether to include memory
- whether to include tool history
- summarization after N turns
- priority rules
- compression strategy

## Tool execution flow

Tool execution is always mediated by the tool runtime.

```
LLM request or runtime decision
    │
    ▼
Tool call request
    │
    ▼
Input validation
    │
    ▼
Authorization
    │
    ▼
Guardrails
    │
    ▼
Execution with timeout/retry/rate limit
    │
    ▼
Result validation
    │
    ▼
Audit event
    │
    ▼
Return to runtime/LLM
```

The LLM never executes tools directly.

## Knowledge retrieval flow

```
Query
    │
    ▼
Metadata filtering + hybrid retrieval
    │
    ▼
Candidate results
    │
    ▼
Reranking if configured
    │
    ▼
Citations + sources attached
    │
    ▼
Context assembly
```

Citations and source identity are preserved so generated answers can reference evidence.

## Memory flow

Memory operations follow framework policies, not automatic dumping.

```
Memory read request
    │
    ▼
Scope/ownership/permission check
    │
    ▼
Memory retrieval
    │
    ▼
Relevance filtering
    │
    ▼
Return to context/runtime
```

Memory writes are governed by policy: what is worth keeping, what has TTL, what has ownership, and what has provenance.

## Execution state flow

Execution state is the persistent backbone of the framework.

During a run, the framework persists:

- run state
- steps
- tool calls
- LLM calls
- retrieval events
- memory operations
- approvals
- errors
- retries
- telemetry metadata

This allows later reconstruction of:

- what happened
- when
- why
- which agent
- which user
- which tools
- which model
- which data
- which permissions
- which failures
- which retries
