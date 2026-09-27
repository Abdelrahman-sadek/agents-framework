# Observability

`@agent-framework/observability` consumes the framework's typed [event stream](./architecture/events.md). Every sink is an `EventSink`: attach as many as you like to `createRuntime({ events })` or an orchestrator. A failing sink never breaks a run.

## OpenTelemetry

```ts
import { openTelemetrySink } from "@agent-framework/observability";
import { metrics, trace } from "@opentelemetry/api";

createRuntime({ providers, events: [openTelemetrySink({ tracer: trace.getTracer("agents"), meter: metrics.getMeter("agents") })] });
```

Register any OpenTelemetry SDK or exporter in your application. Without one the API is a no-op.

```
agent.run support                       (agent.run_id, agent.id, enduser.id, enduser.tenant_id, agent.status)
 ├── gen_ai.chat claude-opus-5          (gen_ai.system, gen_ai.request.model, gen_ai.usage.*, cost, finish reason)
 ├── agent.tool lookup_order            (gen_ai.tool.name, gen_ai.tool.call.id) + authorization/approval span events
 └── gen_ai.chat claude-opus-5
orchestration.run quarterly-review
 └── orchestration.worker data …
```

Metrics: `agent.runs` (by status), `gen_ai.client.token.usage` (input/output), `agent.llm.cost`, `agent.tool.calls` (by outcome), `gen_ai.client.operation.duration`.

## Logs, redaction and traces on disk

```ts
events: [
  redactingSink(logSink({ format: "json" }), { dropKeys: ["reason"] }), // default patterns scrub emails, keys, tokens, card numbers
  fileEventSink("./.agent/events.jsonl"),                              // for `agent trace <run-id> --events ...`
]
```

Event payloads never contain message content, tool arguments or tool outputs. Redaction adds a second layer for reasons and error messages.

## Cost tracking

```ts
const costs = new CostTracker();
createRuntime({ providers, events: [costs] });
costs.report(); // total + byAgent / byModel / byTenant / byUser / byRun: calls, tokens, USD
```

Costs come from `ModelCapabilities.pricing` (or provider-reported cost). Enforce budgets per run with `limits.maxCost` / `maxTokens`.

## Run inspection

```ts
const report = inspectRun(result.events);   // status, duration, model calls, tokens, cost, retries, tool outcomes, approvals, guardrails, errors, timeline
console.log(formatRunReport(report));
```

The same report is available from the CLI: `agent trace <run-id> --events events.jsonl`. Persisted state is shown by `agent inspect <run-id> --db runs.db`.
