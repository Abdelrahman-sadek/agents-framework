import type { LimitType, SerializedError } from "./errors.js";
import type { LLMFinishReason, LLMTokenUsage } from "./llm.js";
import type { StepKind, UsageTotals } from "./types.js";
import type { ApprovalRequest } from "./tool.js";
import type { GuardrailStage } from "./guardrail.js";
import type { Clock, IdGenerator } from "./runtime-deps.js";
import { randomIds, systemClock } from "./runtime-deps.js";

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

  CONTEXT_RETRIEVED: { provider: string; itemCount: number; durationMs: number };
  CONTEXT_ASSEMBLED: { messageCount: number; estimatedTokens?: number; omitted?: { reason: string; count: number }[] };
  RETRIEVAL_COMPLETED: { source: string; resultCount: number; topScore?: number; durationMs: number };
  MEMORY_READ: { store: string; kind?: string; resultCount: number };
  MEMORY_WRITTEN: { store: string; kind: string; memoryId: string };
  MEMORY_REJECTED: { store: string; kind: string; reason: string };
  GUARDRAIL_TRIGGERED: { guardrail: string; stage: GuardrailStage; action: "block" | "redact"; reason: string; toolName?: string };
  OUTPUT_VALIDATION_FAILED: { attempt: number; willRetry: boolean; error: SerializedError };
  VERIFICATION_COMPLETED: { verifier: string; passed: boolean; attempt: number; score?: number };
  VERIFICATION_FAILED: { attempt: number; willRetry: boolean; failures: { verifier: string; feedback: string }[] };

  ORCHESTRATION_STARTED: { orchestrator: string; goal: string };
  PLAN_CREATED: { planId: string; stepCount: number; revision: number };
  WORKER_SCHEDULED: { planStepId: string; worker: string; attempt: number };
  WORKER_COMPLETED: { planStepId: string; worker: string; attempts: number; durationMs: number };
  WORKER_FAILED: { planStepId: string; worker: string; attempt: number; willRetry: boolean; error: SerializedError };
  REPLANNING_REQUESTED: { reason: string; revision: number };
  ORCHESTRATION_COMPLETED: { stepsCompleted: number; durationMs: number };
  ORCHESTRATION_FAILED: { error: SerializedError };
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

export interface EventEmitterOptions {
  runId: string;
  agentId: string;
  sinks?: readonly EventSink[];
  clock?: Clock;
  ids?: IdGenerator;
  /** Last sequence number already used (to continue a stream). Default 0. */
  startSequence?: number;
  /** Called after each event with its sequence number. */
  onSequence?: (sequence: number) => void;
  onSinkError?: (error: unknown, event: AgentEvent) => void;
}

export interface EventEmitterHandle {
  readonly emit: EmitFn;
  readonly events: AgentEvent[];
  readonly sequence: number;
}

/**
 * Build sequenced, correlated envelopes and fan them out to sinks. A sink that
 * throws or rejects never affects the caller. Used by the agent runtime and by
 * other packages (orchestration, evaluation) that emit into the same stream.
 */
export function createEventEmitter(options: EventEmitterOptions): EventEmitterHandle {
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? randomIds;
  const sinks = options.sinks ?? [];
  const onSinkError = options.onSinkError ?? (() => {});
  const events: AgentEvent[] = [];
  let sequence = options.startSequence ?? 0;
  const emit: EmitFn = (type, payload, correlation) => {
    sequence += 1;
    options.onSequence?.(sequence);
    const event = {
      eventId: ids.next("event"),
      sequence,
      runId: options.runId,
      agentId: options.agentId,
      occurredAt: clock.now().toISOString(),
      type,
      payload,
      ...(correlation === undefined ? {} : { correlation }),
    } as AgentEvent;
    events.push(event);
    for (const sink of sinks) {
      try {
        const maybe = sink.emit(event);
        if (maybe instanceof Promise) maybe.catch((error: unknown) => onSinkError(error, event));
      } catch (error) {
        onSinkError(error, event);
      }
    }
  };
  return {
    emit,
    events,
    get sequence() {
      return sequence;
    },
  };
}
