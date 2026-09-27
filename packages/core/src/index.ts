/**
 * @agent-framework/core — public API.
 *
 * Everything exported here follows semantic versioning. Symbols marked
 * `@experimental` in their doc comment may change in minor releases.
 */
export { defineAgent } from "./agent.js";
export type { Agent, AgentConfig, AgentRunResult, AgentRuntime, RecoverOptions, ResumeOptions, RunOptions } from "./agent.js";

export { createRuntime, raceAbort, sleep } from "./runtime.js";
export type { RuntimeOptions } from "./runtime.js";

export * from "./errors.js";

export { InMemoryEventSink, createEventEmitter, noopEmit } from "./events.js";
export type {
  AgentEvent,
  AgentEventOf,
  AgentEventPayloads,
  AgentEventType,
  EmitFn,
  EventCorrelation,
  EventEmitterHandle,
  EventEmitterOptions,
  EventSink,
} from "./events.js";

export { estimateCostUsd } from "./llm.js";
export type {
  LLMFinishReason,
  LLMMessage,
  LLMModelSelector,
  LLMProvider,
  LLMRequest,
  LLMRequestSettings,
  LLMResponse,
  LLMStreamEvent,
  LLMTokenUsage,
  LLMToolCall,
  LLMToolDefinition,
  ModelCapabilities,
  ModelPricing,
} from "./llm.js";

export type {
  AgentTool,
  ApprovalDecision,
  ApprovalRequest,
  ToolInvocation,
  ToolInvocationResult,
  ToolInvocationStatus,
  ToolInvoker,
} from "./tool.js";

export { hasPermission } from "./identity.js";
export type { AgentIdentity, Principal, RunIdentity } from "./identity.js";

export type { InferSchema, JsonSchema, Schema, SchemaParseResult } from "./schema.js";

export { DEFAULT_RUN_LIMITS, TERMINAL_STATUSES, emptyUsage } from "./types.js";
export type {
  AgentState,
  AgentStatus,
  ExecutionStep,
  PendingApproval,
  ResolvedRunLimits,
  RunLimits,
  StepKind,
  StepStatus,
  UsageTotals,
} from "./types.js";

export { resolveLimits, validateLimits } from "./limits.js";

export { InMemoryRunStateStore } from "./state-store.js";
export type { RunStateStore } from "./state-store.js";

export { passthroughContext, renderContextItems, withContextItems } from "./context.js";
export type {
  ContextAssemblyRequest,
  ContextAssemblyResult,
  ContextItem,
  ContextManager,
  ContextProvider,
  ContextProviderRequest,
} from "./context.js";

export { applyGuardrails } from "./guardrail.js";
export type { Guardrail, GuardrailContext, GuardrailOutcome, GuardrailResult, GuardrailStage } from "./guardrail.js";

export { citationVerifier, llmCritic, ruleVerifier } from "./reflection.js";
export type { LLMCriticOptions, ReflectionConfig, VerificationContext, VerificationResult, Verifier } from "./reflection.js";

export { cosineSimilarity } from "./embeddings.js";
export type { EmbeddingProvider } from "./embeddings.js";

export { createDecisionEngine, ruleDecisionProvider } from "./decision.js";
export type {
  Decision,
  DecisionEngine,
  DecisionEngineOptions,
  DecisionKind,
  DecisionProvider,
  DecisionRequest,
  DecisionVerdict,
} from "./decision.js";

export { randomIds, sequentialIds, systemClock } from "./runtime-deps.js";
export type { Clock, IdGenerator } from "./runtime-deps.js";
