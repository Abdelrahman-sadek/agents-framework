/**
 * @agent-framework/orchestration — planning, orchestration and multi-agent patterns.
 *
 * Multi-agent is optional. Prefer a single agent with good tools; reach for an
 * orchestrator when work decomposes into independent, verifiable steps.
 */
export { llmPlanner, staticPlanner, validatePlan } from "./plan.js";
export type { Plan, PlanStep, PlanStepState, PlanStepStatus, Planner, PlanningRequest, WorkerInfo } from "./plan.js";
export { defineWorker, renderTask } from "./worker.js";
export type { Worker, WorkerConfig, WorkerTask } from "./worker.js";
export { defineOrchestrator } from "./orchestrator.js";
export type { AggregationContext, OrchestrationResult, OrchestrationRunOptions, Orchestrator, OrchestratorConfig } from "./orchestrator.js";
export { agentAsTool, agentVerifier, currentDelegationDepth, runParallel, runPipeline, supervisor } from "./multi-agent.js";
export type { AgentAsToolOptions, PatternResult, PatternRunOptions, SupervisorConfig } from "./multi-agent.js";
