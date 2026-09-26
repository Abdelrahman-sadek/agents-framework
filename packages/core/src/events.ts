import type { EventEnvelope } from "./types.js";

export type AgentEvent =
  | AgentStarted
  | AgentCompleted
  | AgentFailed
  | AgentCancelled
  | AgentTimedOut
  | AgentWaitingForApproval
  | ApprovalRequested
  | ApprovalResolved
  | LLMCallStarted
  | LLMCallCompleted
  | LLMCallFailed
  | LLMCallRetried
  | ToolCallStarted
  | ToolCallCompleted
  | ToolCallFailed
  | ToolCallRejected
  | ToolCallApprovalRequired
  | ToolCallTimedOut
  | StepStarted
  | StepCompleted
  | StepFailed
  | StepRetried
  | MemoryRead
  | MemoryWrite
  | MemorySearch
  | RetrievalStarted
  | RetrievalCompleted
  | AuthorizationDecision
  | GuardrailPassed
  | GuardrailBlocked
  | PolicyViolation
  | OrchestrationStarted
  | WorkerScheduled
  | WorkerCompleted
  | WorkerFailed
  | DependencyResolved
  | RePlanningRequested
  | BudgetExceeded;

export interface AgentStarted {
  type: "AGENT_STARTED";
  payload: {
    runId: string;
    agentId: string;
    name: string;
    input: unknown;
  };
}

export interface AgentCompleted {
  type: "AGENT_COMPLETED";
  payload: {
    runId: string;
    agentId: string;
    status: "COMPLETED";
    output: unknown;
  };
}

export interface AgentFailed {
  type: "AGENT_FAILED";
  payload: {
    runId: string;
    agentId: string;
    status: "FAILED";
    error: { code: string; message: string };
  };
}

export interface AgentCancelled {
  type: "AGENT_CANCELLED";
  payload: {
    runId: string;
    agentId: string;
    status: "CANCELLED";
  };
}

export interface AgentTimedOut {
  type: "AGENT_TIMED_OUT";
  payload: {
    runId: string;
    agentId: string;
    status: "TIMED_OUT";
  };
}

export interface AgentWaitingForApproval {
  type: "AGENT_WAITING_FOR_APPROVAL";
  payload: {
    runId: string;
    agentId: string;
    status: "WAITING_FOR_APPROVAL";
  };
}

export interface ApprovalRequested {
  type: "APPROVAL_REQUESTED";
  payload: {
    approvalId: string;
    runId: string;
    agentId: string;
    actionDescription: string;
    stepId?: string;
    toolCallId?: string;
    requestedAt: string;
    expiresAt?: string;
  };
}

export interface ApprovalResolved {
  type: "APPROVAL_RESOLVED";
  payload: {
    approvalId: string;
    runId: string;
    agentId: string;
    decision: "APPROVED" | "REJECTED" | "EXPIRED" | "ESCALATED";
    respondedAt: string;
  };
}

export interface LLMCallStarted {
  type: "LLMCALL_STARTED";
  payload: {
    llmCallId: string;
    runId: string;
    agentId: string;
    provider: string;
    model: string;
  };
}

export interface LLMCallCompleted {
  type: "LLMCALL_COMPLETED";
  payload: {
    llmCallId: string;
    runId: string;
    agentId: string;
    provider: string;
    model: string;
    tokenUsage: { inputTokens: number; outputTokens: number; cachedTokens?: number };
    estimatedCost?: number;
  };
}

export interface LLMCallFailed {
  type: "LLMCALL_FAILED";
  payload: {
    llmCallId: string;
    runId: string;
    agentId: string;
    provider: string;
    model: string;
    error: { code: string; message: string };
  };
}

export interface LLMCallRetried {
  type: "LLMCALL_RETRIED";
  payload: {
    llmCallId: string;
    runId: string;
    agentId: string;
    provider: string;
    model: string;
    attempt: number;
  };
}

export interface ToolCallStarted {
  type: "TOOLCALL_STARTED";
  payload: {
    toolCallId: string;
    runId: string;
    agentId: string;
    toolName: string;
    input: unknown;
  };
}

export interface ToolCallCompleted {
  type: "TOOLCALL_COMPLETED";
  payload: {
    toolCallId: string;
    runId: string;
    agentId: string;
    toolName: string;
    output: unknown;
    durationMs?: number;
  };
}

export interface ToolCallFailed {
  type: "TOOLCALL_FAILED";
  payload: {
    toolCallId: string;
    runId: string;
    agentId: string;
    toolName: string;
    error: { code: string; message: string };
    retryCount?: number;
  };
}

export interface ToolCallRejected {
  type: "TOOLCALL_REJECTED";
  payload: {
    toolCallId: string;
    runId: string;
    agentId: string;
    toolName: string;
    reason: string;
  };
}

export interface ToolCallApprovalRequired {
  type: "TOOLCALL_APPROVAL_REQUIRED";
  payload: {
    toolCallId: string;
    runId: string;
    agentId: string;
    toolName: string;
    actionDescription: string;
    approvalId: string;
    expiresAt?: string;
  };
}

export interface ToolCallTimedOut {
  type: "TOOLCALL_TIMED_OUT";
  payload: {
    toolCallId: string;
    runId: string;
    agentId: string;
    toolName: string;
    timeoutMs: number;
  };
}

export interface StepStarted {
  type: "STEP_STARTED";
  payload: {
    stepId: string;
    runId: string;
    agentId: string;
    description: string;
  };
}

export interface StepCompleted {
  type: "STEP_COMPLETED";
  payload: {
    stepId: string;
    runId: string;
    agentId: string;
    outputs: unknown;
  };
}

export interface StepFailed {
  type: "STEP_FAILED";
  payload: {
    stepId: string;
    runId: string;
    agentId: string;
    error: { code: string; message: string };
  };
}

export interface StepRetried {
  type: "STEP_RETRIED";
  payload: {
    stepId: string;
    runId: string;
    agentId: string;
    attempt: number;
  };
}

export interface MemoryRead {
  type: "MEMORY_READ";
  payload: {
    runId: string;
    agentId: string;
    scope: string;
  };
}

export interface MemoryWrite {
  type: "MEMORY_WRITE";
  payload: {
    runId: string;
    agentId: string;
    scope: string;
  };
}

export interface MemorySearch {
  type: "MEMORY_SEARCH";
  payload: {
    runId: string;
    agentId: string;
    scope: string;
  };
}

export interface RetrievalStarted {
  type: "RETRIEVAL_STARTED";
  payload: {
    runId: string;
    agentId: string;
    query: string;
  };
}

export interface RetrievalCompleted {
  type: "RETRIEVAL_COMPLETED";
  payload: {
    runId: string;
    agentId: string;
    query: string;
    count: number;
  };
}

export interface AuthorizationDecision {
  type: "AUTHORIZATION_DECISION";
  payload: {
    runId: string;
    agentId: string;
    allowed: boolean;
    reason?: string;
  };
}

export interface GuardrailPassed {
  type: "GUARDRAIL_PASSED";
  payload: {
    runId: string;
    agentId: string;
    stage: "input" | "output";
  };
}

export interface GuardrailBlocked {
  type: "GUARDRAIL_BLOCKED";
  payload: {
    runId: string;
    agentId: string;
    stage: "input" | "output";
    reason: string;
  };
}

export interface PolicyViolation {
  type: "POLICY_VIOLATION";
  payload: {
    runId: string;
    agentId: string;
    violation: string;
  };
}

export interface OrchestrationStarted {
  type: "ORCHESTRATION_STARTED";
  payload: {
    runId: string;
    agentId: string;
    orchestratorId: string;
  };
}

export interface WorkerScheduled {
  type: "WORKER_SCHEDULED";
  payload: {
    runId: string;
    agentId: string;
    workerId: string;
    taskId: string;
  };
}

export interface WorkerCompleted {
  type: "WORKER_COMPLETED";
  payload: {
    runId: string;
    agentId: string;
    workerId: string;
    taskId: string;
    result: unknown;
  };
}

export interface WorkerFailed {
  type: "WORKER_FAILED";
  payload: {
    runId: string;
    agentId: string;
    workerId: string;
    taskId: string;
    error: { code: string; message: string };
  };
}

export interface DependencyResolved {
  type: "DEPENDENCY_RESOLVED";
  payload: {
    runId: string;
    agentId: string;
    stepId: string;
  };
}

export interface RePlanningRequested {
  type: "REPLANNING_REQUESTED";
  payload: {
    runId: string;
    agentId: string;
    reason: string;
  };
}

export interface BudgetExceeded {
  type: "BUDGET_EXCEEDED";
  payload: {
    runId: string;
    agentId: string;
    limitType: "tokens" | "cost" | "steps" | "toolCalls";
    limit: number;
    current: number;
  };
}

export function toEnvelope(event: AgentEvent, agentId: string, actor?: string, correlationId?: string): EventEnvelope {
  const now = new Date().toISOString();
  return {
    eventId: crypto.randomUUID(),
    runId: runIdOf(event),
    agentId,
    occurredAt: now,
    type: event.type,
    actor,
    correlationId,
    payload: event.payload,
    metadata: undefined,
  };
}

function runIdOf(event: AgentEvent): string {
  const payload = event.payload as { runId?: string };
  return payload.runId ?? "";
}
