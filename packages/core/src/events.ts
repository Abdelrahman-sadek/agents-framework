import type { LimitType, SerializedError } from "./errors.js";
import type { LLMFinishReason, LLMTokenUsage } from "./llm.js";
import type { StepKind, UsageTotals } from "./types.js";
import type { ApprovalRequest } from "./tool.js";

/**
 * Typed runtime event model.
 *
 * Events feed observability, audit, persistence, UI streaming and
 * integrations. OpenTelemetry is one consumer (a later-phase sink); it does not
 * own this model. Payloads never contain raw tool arguments or outputs.
 */
export interface AgentEventPayloads {
  AGENT_STARTED: { agentVersion?: string; userId?: string; tenantId?: string };
  AGENT_COMPLETED: { usage: UsageTotals };
  AGENT_FAILED: { error: SerializedError; usage: UsageTotals };
  AGENT_CANCELLED: { reason: string };
  AGENT_TIMED_OUT: { timeoutMs: number };
  AGENT_WAITING_FOR_APPROVAL: { approvals: ApprovalRequest[] };
  AGENT_RESUMED: { decisions: { approvalId: string; decision: string }[] };

  STEP_STARTED: { stepId: string; kind: StepKind; index: number };
  STEP_COMPLETED: { stepId: string; kind: StepKind };
  STEP_FAILED: { stepId: string; kind: StepKind; error: SerializedError };

  LLM_CALL_STARTED: { llmCallId: string; providerId: string; modelId: string; attempt: number; messageCount: number; toolCount: number };
  LLM_CALL_COMPLETED: {
    llmCallId: string;
    providerId: string;
    modelId: string;
    finishReason: LLMFinishReason;
    usage: LLMTokenUsage;
    estimatedCostUsd: number;
    toolCallCount: number;
    durationMs: number;
  };
  LLM_CALL_FAILED: { llmCallId: string; providerId: string; modelId: string; attempt: number; willRetry: boolean; error: SerializedError };

  TOOL_REQUESTED: { toolCallId: string; toolName: string };
  TOOL_AUTHORIZATION_STARTED: { toolCallId: string; toolName: string };
  TOOL_AUTHORIZATION_COMPLETED: { toolCallId: string; toolName: string; allowed: boolean; policy: string; reason: string };
  TOOL_EXECUTION_STARTED: { toolCallId: string; toolName: string; attempt: number };
  TOOL_EXECUTION_COMPLETED: { toolCallId: string; toolName: string; attempts: number; durationMs: number; cached: boolean };
  TOOL_EXECUTION_FAILED: { toolCallId: string; toolName: string; attempt: number; willRetry: boolean; error: SerializedError };
  TOOL_EXECUTION_TIMED_OUT: { toolCallId: string; toolName: string; attempt: number; willRetry: boolean; timeoutMs: number };
  TOOL_APPROVAL_REQUIRED: { toolCallId: string; toolName: string; approvalId: string; expiresAt?: string };
  TOOL_APPROVAL_GRANTED: { toolCallId: string; toolName: string; approvalId: string; decidedBy?: string };
  TOOL_APPROVAL_REJECTED: { toolCallId: string; toolName: string; approvalId: string; decidedBy?: string; reason?: string };

  LIMIT_EXCEEDED: { limitType: LimitType; limit: number; current: number };
}

export type AgentEventType = keyof AgentEventPayloads;

export interface EventCorrelation {
  stepId?: string;
  llmCallId?: string;
  toolCallId?: string;
}

interface EventEnvelopeBase {
  eventId: string;
  /** Monotonic per run, continues across resume. */
  sequence: number;
  runId: string;
  agentId: string;
  occurredAt: string;
  correlation?: EventCorrelation;
}

export type AgentEvent = {
  [K in AgentEventType]: EventEnvelopeBase & { type: K; payload: AgentEventPayloads[K] };
}[AgentEventType];

export type AgentEventOf<K extends AgentEventType> = Extract<AgentEvent, { type: K }>;

export type EmitFn = <K extends AgentEventType>(
  type: K,
  payload: AgentEventPayloads[K],
  correlation?: EventCorrelation,
) => void;

export interface EventSink {
  emit(event: AgentEvent): void | Promise<void>;
}

/** Collects events in memory. Intended for tests, development and small tools. */
export class InMemoryEventSink implements EventSink {
  readonly events: AgentEvent[] = [];
  emit(event: AgentEvent): void {
    this.events.push(event);
  }
  ofType<K extends AgentEventType>(type: K): AgentEventOf<K>[] {
    return this.events.filter((e): e is AgentEventOf<K> => e.type === type);
  }
  clear(): void {
    this.events.length = 0;
  }
}

/** A no-op emitter for invoking tools outside of an agent run. */
export const noopEmit: EmitFn = () => {};
