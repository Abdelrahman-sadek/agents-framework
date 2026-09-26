# Lifecycles

This document expands the state transitions and guarantees for each major runtime lifecycle.

## Agent run lifecycle

An agent run is the top-level unit of work. It has a run id, agent id, user identity, tenant context, and a persistent state record.

Core states:

- `INITIALIZED`
- `GUARDRAILS_INPUT`
- `AUTHORIZED`
- `CONTEXT_ASSEMBLED`
- `PLANNING`
- `EXECUTING`
- `REFLECTING`
- `GUARDRAILS_OUTPUT`
- `COMPLETED`
- `FAILED`
- `CANCELLED`
- `TIMEOUT`
- `WAITING_FOR_APPROVAL`
- `APPROVAL_REJECTED`
- `APPROVAL_EXPIRED`

Invariants:

- every state transition is recorded
- every run has a run id used across observability and persistence
- budgets and limits can stop execution
- approvals pause execution without losing state

## Tool execution lifecycle

Tool calls are not free-form function calls. They go through a defined runtime.

States:

- `TOOL_REQUESTED`
- `VALIDATED`
- `AUTHORIZED`
- `GUARDRAILED`
- `EXECUTING`
- `RESULT_VALIDATED`
- `COMPLETED`
- `FAILED`
- `TIMEOUT`
- `REJECTED`
- `APPROVAL_REQUIRED`

Invariants:

- tool input is validated against the tool's schema
- authorization is deterministic
- tool execution is bounded by timeout and retry policy
- tool outputs are validated
- the call is recorded for audit

## Planning lifecycle

Plans are structured and observable. The planner produces a plan, the runtime validates and schedules it, and the runtime monitors execution.

States:

- `TASK_RECEIVED`
- `PLAN_GENERATED`
- `PLAN_VALIDATED`
- `STEPS_SCHEDULED`
- `STEP_EXECUTING`
- `STEP_COMPLETED`
- `STEP_FAILED`
- `REPLANNING`
- `PLAN_COMPLETED`
- `PLAN_FAILED`

Invariants:

- plan steps have dependencies, status, worker assignment, inputs, outputs, timeout, and retry policy
- the runtime can re-plan when needed
- the plan does not get executed by blind trust; each step is tracked

## Reflection lifecycle

Reflection can be invoked on generated output or intermediate results.

States:

- `OUTPUT_GENERATED`
- `VALIDATION_STARTED`
- `VERIFIED`
- `FLAGGED`
- `CORRECTION_ATTEMPTED`
- `VERIFICATION_FAILED`
- `FINALIZED`

Invariants:

- reflection strategy is configurable per agent/run
- reflection is bounded by `maxAttempts`
- reflection does not become an open-ended self-critique loop

## Orchestration lifecycle

Orchestration coordinates workers and dependencies.

States:

- `ORCHESTRATOR_INITIALIZED`
- `WORKERS_SCHEDULED`
- `WORKERS_RUNNING`
- `DEPENDENCY_RESOLVED`
- `RESULTS_AGGREGATED`
- `VERIFICATION_IF_NEEDED`
- `ORCHESTRATION_COMPLETED`
- `ORCHESTRATION_FAILED`

Invariants:

- worker permissions are limited
- parallelism is controlled
- failure and timeout are explicit
- aggregation is deterministic where possible

## Human approval lifecycle

Approval is first-class, not a side effect.

States:

- `ACTION_PROPOSED`
- `APPROVAL_REQUESTED`
- `WAITING_FOR_APPROVAL`
- `APPROVED`
- `REJECTED`
- `EXPIRED`
- `ESCALATED`
- `CANCELLED`

Invariants:

- approval state is persisted
- a restart does not lose a pending approval
- approval can carry expiration and escalation rules
- only the relevant authorized human/process can approve

## Execution durability lifecycle

Durable execution is modeled as a state machine with recoverable checkpoints.

Typical durable execution flow:

```
SUBMITTED
    │
    ▼
QUEUED
    │
    ▼
RUNNING
    │
    ▼
CHECKPOINTED_STATE
    │
    ▼
...execution with possible pauses...
    │
    ▼
COMPLETED / FAILED / WAITING / CANCELLED
```

Durable execution must support:

- recovery after crash
- long-running tasks
- timers and waits
- human approval pauses
- retries
- idempotency

This is why durable execution is abstracted behind a runner interface and never hard-coded to one backend.
