# Event architecture

Events are the runtime's typed record of what happened. They support observability, audit, debugging, persistence, UI streaming, and future event-driven integrations.

## Separation of concerns

Events are **not** the same thing as OpenTelemetry spans.

- Events are the runtime's logical record of execution.
- OpenTelemetry is one consumer of runtime activity.
- The runtime may emit events and also create spans, but the event model itself is not owned by observability.

This matters because events must remain useful for audit and persistence even if telemetry configuration changes.

## Event design goals

- typed
- append-only in practice
- attributable to a run, step, and/or tool call
- safe to persist
- safe to stream to UIs
- extensible without collapsing into an untyped blob

## Event categories

### Run-level events

- agent started
- agent completed
- agent failed
- agent cancelled
- agent timed out
- agent waiting for approval
- agent approval requested
- agent approval resolved

### LLM events

- LLM call started
- LLM call completed
- LLM call failed
- LLM call retry
- structured output validation result

### Tool events

- tool call started
- tool call completed
- tool call failed
- tool call rejected
- tool call approval required
- tool call timeout

### Step events

- step started
- step completed
- step failed
- step retried

### Memory and knowledge events

- memory read
- memory write
- memory search
- retrieval started
- retrieval completed

### Security/events

- authorization decision
- guardrail pass
- guardrail blocked
- policy violation

### Workflow/orchestration events

- orchestration started
- worker scheduled
- worker completed
- worker failed
- dependency resolved
- re-planning requested

## Event shape

A stable event envelope is preferred.

```typescript
interface AgentEvent {
  eventId: string;
  runId: string;
  agentId: string;
  occurredAt: string;
  type: string;
  actor?: string;
  correlationId?: string;
  payload: unknown;
  metadata?: Record<string, unknown>;
}
```

Concrete event types should be defined for the most important lifecycle points, for example:

```typescript
type AgentEvent =
  | AgentStarted
  | AgentCompleted
  | AgentFailed
  | LLMCallStarted
  | LLMCallCompleted
  | ToolCallStarted
  | ToolCallCompleted
  | ToolCallFailed
  | StepStarted
  | StepCompleted
  | ApprovalRequested
  | ApprovalResolved;
```

## Keep events safe

Event payloads should be designed to avoid blindly storing sensitive data. Where needed, events should carry summarized or redacted information and reference external records rather than embedding secrets or full documents.

## Consumers

Possible consumers:

- persistence layer
- observability layer
- UI streaming
- approval systems
- evaluation systems
- future async integrations

The runtime should not assume there is only one consumer.
