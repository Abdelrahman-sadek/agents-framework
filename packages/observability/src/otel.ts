import { SpanKind, SpanStatusCode, context, trace, type Attributes, type Meter, type Span, type Tracer } from "@opentelemetry/api";
import type { AgentEvent, EventSink } from "@agent-framework/core";

export interface OpenTelemetrySinkOptions {
  /** Default: `trace.getTracer("@agent-framework")` (a no-op until an SDK is registered). */
  tracer?: Tracer;
  meter?: Meter;
}

/**
 * Bridge the framework event stream to OpenTelemetry. One span per run (or
 * orchestration), child spans per step (model call, tool call) and per worker.
 * Attributes follow the GenAI semantic conventions where they exist. Only ids,
 * names, counts, usage and error codes are recorded; message content never is.
 */
export function openTelemetrySink(options: OpenTelemetrySinkOptions = {}): EventSink {
  const tracer = options.tracer ?? trace.getTracer("@agent-framework");
  const runs = new Map<string, Span>();
  const children = new Map<string, Span>();
  const meter = options.meter;
  const runCounter = meter?.createCounter("agent.runs", { description: "Agent runs by final status" });
  const tokenCounter = meter?.createCounter("gen_ai.client.token.usage", { unit: "{token}" });
  const costCounter = meter?.createCounter("agent.llm.cost", { unit: "USD" });
  const toolCounter = meter?.createCounter("agent.tool.calls");
  const llmDuration = meter?.createHistogram("gen_ai.client.operation.duration", { unit: "ms" });

  const root = (event: AgentEvent, name: string): Span => {
    const span = tracer.startSpan(name, { kind: SpanKind.INTERNAL, attributes: { "agent.run_id": event.runId, "agent.id": event.agentId } });
    runs.set(event.runId, span);
    return span;
  };
  const child = (event: AgentEvent, key: string, name: string, attributes: Attributes): void => {
    const parent = runs.get(event.runId);
    const ctx = parent === undefined ? context.active() : trace.setSpan(context.active(), parent);
    children.set(`${event.runId}:${key}`, tracer.startSpan(name, { attributes: { "agent.run_id": event.runId, ...attributes } }, ctx));
  };
  const endChild = (event: AgentEvent, key: string, error?: { code: string; message: string }): void => {
    const span = children.get(`${event.runId}:${key}`);
    if (span === undefined) return;
    if (error !== undefined) span.setStatus({ code: SpanStatusCode.ERROR, message: `${error.code}: ${error.message}` });
    span.end();
    children.delete(`${event.runId}:${key}`);
  };
  const endRun = (event: AgentEvent, status: string, error?: { code: string; message: string }): void => {
    const span = runs.get(event.runId);
    runCounter?.add(1, { "agent.id": event.agentId, "agent.status": status });
    if (span === undefined) return;
    span.setAttribute("agent.status", status);
    span.setStatus(error === undefined ? { code: SpanStatusCode.OK } : { code: SpanStatusCode.ERROR, message: `${error.code}: ${error.message}` });
    span.end();
    runs.delete(event.runId);
  };

  return {
    emit(event) {
      const stepKey = event.correlation?.stepId;
      switch (event.type) {
        case "AGENT_STARTED": {
          const span = root(event, `agent.run ${event.agentId}`);
          if (event.payload.tenantId !== undefined) span.setAttribute("enduser.tenant_id", event.payload.tenantId);
          if (event.payload.userId !== undefined) span.setAttribute("enduser.id", event.payload.userId);
          return;
        }
        case "AGENT_RESUMED":
          if (!runs.has(event.runId)) root(event, `agent.resume ${event.agentId}`);
          return;
        case "ORCHESTRATION_STARTED":
          root(event, `orchestration.run ${event.payload.orchestrator}`);
          return;
        case "STEP_STARTED":
          child(event, event.payload.stepId, event.payload.kind === "llm_call" ? "gen_ai.chat" : "agent.tool", { "agent.step.index": event.payload.index });
          return;
        case "STEP_COMPLETED":
          endChild(event, event.payload.stepId);
          return;
        case "STEP_FAILED":
          endChild(event, event.payload.stepId, event.payload.error);
          return;
        case "LLM_CALL_COMPLETED": {
          const span = stepKey === undefined ? undefined : children.get(`${event.runId}:${stepKey}`);
          const p = event.payload;
          span?.setAttributes({
            "gen_ai.system": p.providerId,
            "gen_ai.request.model": p.modelId,
            "gen_ai.usage.input_tokens": p.usage.inputTokens,
            "gen_ai.usage.output_tokens": p.usage.outputTokens,
            "gen_ai.response.finish_reasons": [p.finishReason],
            "agent.llm.cost_usd": p.estimatedCostUsd,
          });
          span?.updateName(`gen_ai.chat ${p.modelId}`);
          const attrs = { "gen_ai.system": p.providerId, "gen_ai.request.model": p.modelId, "agent.id": event.agentId };
          tokenCounter?.add(p.usage.inputTokens, { ...attrs, "gen_ai.token.type": "input" });
          tokenCounter?.add(p.usage.outputTokens, { ...attrs, "gen_ai.token.type": "output" });
          costCounter?.add(p.estimatedCostUsd, attrs);
          llmDuration?.record(p.durationMs, attrs);
          return;
        }
        case "TOOL_REQUESTED": {
          const span = stepKey === undefined ? undefined : children.get(`${event.runId}:${stepKey}`);
          span?.updateName(`agent.tool ${event.payload.toolName}`);
          span?.setAttributes({ "gen_ai.tool.name": event.payload.toolName, "gen_ai.tool.call.id": event.payload.toolCallId });
          return;
        }
        case "TOOL_EXECUTION_COMPLETED":
        case "TOOL_EXECUTION_FAILED":
        case "TOOL_EXECUTION_TIMED_OUT":
          toolCounter?.add(1, { "gen_ai.tool.name": event.payload.toolName, "agent.tool.outcome": event.type.slice("TOOL_EXECUTION_".length).toLowerCase() });
          break;
        case "WORKER_SCHEDULED":
          child(event, `worker:${event.payload.planStepId}`, `orchestration.worker ${event.payload.worker}`, { "agent.plan_step_id": event.payload.planStepId, "agent.worker": event.payload.worker, "agent.attempt": event.payload.attempt });
          return;
        case "WORKER_COMPLETED":
          endChild(event, `worker:${event.payload.planStepId}`);
          return;
        case "WORKER_FAILED":
          endChild(event, `worker:${event.payload.planStepId}`, event.payload.error);
          return;
        case "AGENT_COMPLETED":
        case "ORCHESTRATION_COMPLETED":
          endRun(event, "COMPLETED");
          return;
        case "AGENT_FAILED":
        case "ORCHESTRATION_FAILED":
          endRun(event, "FAILED", event.payload.error);
          return;
        case "AGENT_CANCELLED":
          endRun(event, "CANCELLED", { code: "CANCELLED", message: event.payload.reason });
          return;
        case "AGENT_TIMED_OUT":
          endRun(event, "TIMED_OUT", { code: "RUN_TIMEOUT", message: `after ${event.payload.timeoutMs}ms` });
          return;
        case "AGENT_WAITING_FOR_APPROVAL":
          endRun(event, "WAITING_FOR_APPROVAL");
          return;
        default:
          break;
      }
      // Everything else becomes a span event on the closest span.
      const target = (stepKey === undefined ? undefined : children.get(`${event.runId}:${stepKey}`)) ?? runs.get(event.runId);
      target?.addEvent(event.type, flatten(event.payload));
    },
  };
}

function flatten(payload: unknown, prefix = "", out: Attributes = {}): Attributes {
  if (payload === null || typeof payload !== "object") return out;
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    const name = prefix === "" ? key : `${prefix}.${key}`;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[name] = value;
    else if (typeof value === "object" && value !== null && !Array.isArray(value)) flatten(value, name, out);
  }
  return out;
}
