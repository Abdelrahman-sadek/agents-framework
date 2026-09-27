# Events

The runtime emits a typed, ordered stream of events for every run. Events feed observability, audit, persistence, UI streaming and integrations. OpenTelemetry is one *consumer* of this stream through a sink; it does not define it ([ADR 007](../decisions/007-opentelemetry.md)).

## Envelope

```ts
type AgentEvent = {
  eventId: string;
  sequence: number;        // 1, 2, 3… per run; continues across resume()
  runId: string;
  agentId: string;
  occurredAt: string;      // ISO-8601 from the injected Clock
  correlation?: { stepId?: string; llmCallId?: string; toolCallId?: string };
  type: AgentEventType;    // discriminant
  payload: …;              // typed per event type
};
```

`AgentEvent` is a discriminated union, so `switch (event.type)` narrows `payload`.

## Event types

| Group | Types |
| --- | --- |
| Run | `AGENT_STARTED`, `AGENT_COMPLETED`, `AGENT_FAILED`, `AGENT_CANCELLED`, `AGENT_TIMED_OUT`, `AGENT_WAITING_FOR_APPROVAL`, `AGENT_RESUMED` |
| Step | `STEP_STARTED`, `STEP_COMPLETED`, `STEP_FAILED` |
| Model | `LLM_CALL_STARTED`, `LLM_CALL_COMPLETED` (usage, estimated cost, duration), `LLM_CALL_FAILED` (attempt, `willRetry`) |
| Tool | `TOOL_REQUESTED`, `TOOL_AUTHORIZATION_STARTED`, `TOOL_AUTHORIZATION_COMPLETED`, `TOOL_EXECUTION_STARTED`, `TOOL_EXECUTION_COMPLETED`, `TOOL_EXECUTION_FAILED`, `TOOL_EXECUTION_TIMED_OUT`, `TOOL_APPROVAL_REQUIRED`, `TOOL_APPROVAL_GRANTED`, `TOOL_APPROVAL_REJECTED` |
| Limits | `LIMIT_EXCEEDED` (`limitType`, `limit`, `current`) |

Later phases add retrieval, memory, guardrail, planning, reflection and orchestration events to the same union.

A typical tool-using run:

```
AGENT_STARTED
STEP_STARTED(llm_call) LLM_CALL_STARTED LLM_CALL_COMPLETED STEP_COMPLETED
STEP_STARTED(tool_call) TOOL_REQUESTED TOOL_AUTHORIZATION_STARTED TOOL_AUTHORIZATION_COMPLETED
    TOOL_EXECUTION_STARTED TOOL_EXECUTION_COMPLETED STEP_COMPLETED
STEP_STARTED(llm_call) LLM_CALL_STARTED LLM_CALL_COMPLETED STEP_COMPLETED
AGENT_COMPLETED
```

## Sinks

```ts
interface EventSink { emit(event: AgentEvent): void | Promise<void>; }

createRuntime({ providers, events: [consoleSink, otelSink, uiSink], onSinkError });
```

- Sinks are called synchronously in order. Returned promises aren't awaited.
- A sink that throws or rejects **never** affects the run. The error goes to `onSinkError`.
- `InMemoryEventSink` collects events and has `ofType(type)` for tests.
- `result.events` contains the events of that `run()`/`resume()` call.

## Data minimization

Event payloads contain ids, names, statuses, counts, durations, usage and serialized errors. They **do not** contain tool arguments, tool outputs or message content. The run input isn't included in `AGENT_STARTED` either. Content lives in `AgentState` and the tool audit log, where access and retention can be controlled. Configurable redaction for content-bearing telemetry comes with the observability phase.
