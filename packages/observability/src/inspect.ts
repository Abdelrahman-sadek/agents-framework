import type { AgentEvent, SerializedError } from "@agent-framework/core";

export interface RunReport {
  runId: string;
  agentId: string;
  status: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  llmCalls: number;
  toolCalls: { toolName: string; outcome: string; attempts?: number; durationMs?: number }[];
  tokens: { input: number; output: number };
  costUsd: number;
  retries: number;
  guardrails: { guardrail: string; stage: string; action: string }[];
  approvals: { approvalId: string; status: string }[];
  errors: SerializedError[];
  timeline: { sequence: number; at: string; type: string; summary: string }[];
}

const STATUS_BY_EVENT: Partial<Record<AgentEvent["type"], string>> = {
  AGENT_COMPLETED: "COMPLETED",
  AGENT_FAILED: "FAILED",
  AGENT_CANCELLED: "CANCELLED",
  AGENT_TIMED_OUT: "TIMED_OUT",
  AGENT_WAITING_FOR_APPROVAL: "WAITING_FOR_APPROVAL",
  AGENT_RESUMED: "RUNNING",
  ORCHESTRATION_COMPLETED: "COMPLETED",
  ORCHESTRATION_FAILED: "FAILED",
};

function summarize(event: AgentEvent): string {
  const p = event.payload as unknown as Record<string, unknown>;
  const pick = ["toolName", "modelId", "kind", "worker", "planStepId", "guardrail", "verifier", "limitType", "provider", "source", "passed", "allowed", "attempt"]
    .filter((k) => p[k] !== undefined)
    .map((k) => `${k}=${String(p[k])}`);
  const error = p["error"] as { code?: string } | undefined;
  if (error?.code !== undefined) pick.push(`error=${error.code}`);
  if (event.type === "LLM_CALL_COMPLETED") pick.push(`tokens=${event.payload.usage.inputTokens}+${event.payload.usage.outputTokens}`, `cost=$${event.payload.estimatedCostUsd.toFixed(5)}`);
  return pick.join(" ");
}

/** Reconstruct what happened in a run from its events. */
export function inspectRun(events: readonly AgentEvent[]): RunReport {
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence);
  const first = sorted[0];
  const last = sorted.at(-1);
  const report: RunReport = {
    runId: first?.runId ?? "",
    agentId: first?.agentId ?? "",
    status: "RUNNING",
    llmCalls: 0,
    toolCalls: [],
    tokens: { input: 0, output: 0 },
    costUsd: 0,
    retries: 0,
    guardrails: [],
    approvals: [],
    errors: [],
    timeline: [],
    ...(first === undefined ? {} : { startedAt: first.occurredAt }),
    ...(last === undefined ? {} : { endedAt: last.occurredAt }),
  };
  if (first !== undefined && last !== undefined) report.durationMs = Date.parse(last.occurredAt) - Date.parse(first.occurredAt);
  const tools = new Map<string, RunReport["toolCalls"][number]>();
  for (const event of sorted) {
    report.timeline.push({ sequence: event.sequence, at: event.occurredAt, type: event.type, summary: summarize(event) });
    report.status = STATUS_BY_EVENT[event.type] ?? report.status;
    switch (event.type) {
      case "LLM_CALL_COMPLETED":
        report.llmCalls += 1;
        report.tokens.input += event.payload.usage.inputTokens;
        report.tokens.output += event.payload.usage.outputTokens;
        report.costUsd += event.payload.estimatedCostUsd;
        break;
      case "LLM_CALL_FAILED":
      case "TOOL_EXECUTION_FAILED":
      case "WORKER_FAILED":
        if (event.payload.willRetry) report.retries += 1;
        break;
      case "TOOL_REQUESTED":
        tools.set(event.payload.toolCallId, { toolName: event.payload.toolName, outcome: "requested" });
        break;
      case "TOOL_AUTHORIZATION_COMPLETED":
        if (!event.payload.allowed) tools.set(event.payload.toolCallId, { toolName: event.payload.toolName, outcome: "denied" });
        break;
      case "TOOL_EXECUTION_COMPLETED":
        tools.set(event.payload.toolCallId, { toolName: event.payload.toolName, outcome: event.payload.cached ? "cached" : "completed", attempts: event.payload.attempts, durationMs: event.payload.durationMs });
        break;
      case "TOOL_EXECUTION_TIMED_OUT":
        tools.set(event.payload.toolCallId, { toolName: event.payload.toolName, outcome: "timed_out", attempts: event.payload.attempt });
        break;
      case "TOOL_APPROVAL_REQUIRED":
        tools.set(event.payload.toolCallId, { toolName: event.payload.toolName, outcome: "awaiting_approval" });
        report.approvals.push({ approvalId: event.payload.approvalId, status: "requested" });
        break;
      case "TOOL_APPROVAL_GRANTED":
      case "TOOL_APPROVAL_REJECTED": {
        const entry = report.approvals.find((a) => a.approvalId === event.payload.approvalId);
        const status = event.type === "TOOL_APPROVAL_GRANTED" ? "approved" : "rejected";
        if (entry === undefined) report.approvals.push({ approvalId: event.payload.approvalId, status });
        else entry.status = status;
        if (status === "rejected") tools.set(event.payload.toolCallId, { toolName: event.payload.toolName, outcome: "rejected" });
        break;
      }
      case "STEP_FAILED":
        if (event.payload.kind === "tool_call") {
          const id = event.correlation?.toolCallId;
          const entry = id === undefined ? undefined : tools.get(id);
          if (entry !== undefined && ["requested", "completed"].includes(entry.outcome)) entry.outcome = `failed:${event.payload.error.code}`;
        }
        break;
      case "GUARDRAIL_TRIGGERED":
        report.guardrails.push({ guardrail: event.payload.guardrail, stage: event.payload.stage, action: event.payload.action });
        break;
      case "AGENT_FAILED":
      case "ORCHESTRATION_FAILED":
        report.errors.push(event.payload.error);
        break;
      default:
        break;
    }
  }
  report.toolCalls = [...tools.values()];
  return report;
}

/** Human-readable report for terminals (used by `agent trace`). */
export function formatRunReport(report: RunReport): string {
  const lines = [
    `Run ${report.runId}  agent=${report.agentId}  status=${report.status}${report.durationMs === undefined ? "" : `  ${report.durationMs}ms`}`,
    `Model calls: ${report.llmCalls}  tokens: ${report.tokens.input} in / ${report.tokens.output} out  cost: $${report.costUsd.toFixed(5)}  retries: ${report.retries}`,
  ];
  if (report.toolCalls.length > 0) lines.push(`Tools: ${report.toolCalls.map((t) => `${t.toolName}(${t.outcome})`).join(", ")}`);
  if (report.approvals.length > 0) lines.push(`Approvals: ${report.approvals.map((a) => `${a.approvalId}=${a.status}`).join(", ")}`);
  if (report.guardrails.length > 0) lines.push(`Guardrails: ${report.guardrails.map((g) => `${g.guardrail}@${g.stage}:${g.action}`).join(", ")}`);
  for (const e of report.errors) lines.push(`Error: ${e.code} ${e.message}`);
  lines.push("", "Timeline:");
  for (const t of report.timeline) lines.push(`  ${String(t.sequence).padStart(3)}  ${t.type.padEnd(28)} ${t.summary}`);
  return lines.join("\n");
}
