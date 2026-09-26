import type { RunConfig, RunLimits, AgentState, AgentStatus } from "./types.js";
import type { AgentEvent } from "./events.js";
import type { LLMModelSelector, LLMProvider } from "./llm.js";
import type { Tool } from "./tool.js";
import type { DecisionProvider, ContextManager } from "./decision-context.js";

export interface AgentConfig<TOutput = unknown> {
  name: string;
  model: LLMModelSelector;
  instructions?: string;
  system?: string;
  tools?: Tool[];
  limits?: RunLimits;
  outputSchema?: unknown;
  decisionProvider?: DecisionProvider;
  contextManager?: ContextManager;
}

export interface AgentRunResult<TOutput = unknown> {
  runId: string;
  agentId: string;
  status: AgentStatus;
  output?: TOutput;
  error?: { code: string; message: string };
  steps: AgentState["steps"];
  events: AgentEvent[];
  usage?: {
    tokens?: number;
    estimatedCost?: number;
  };
}

export interface Agent<TOutput = unknown> {
  readonly name: string;
  readonly agentId: string;
  readonly config: AgentConfig<TOutput>;
  run(config: RunConfig<unknown>): Promise<AgentRunResult<TOutput>>;
  cancel(runId: string): Promise<void>;
}

export interface AgentDefinition<TOutput = unknown> {
  name: string;
  version?: string;
  config: AgentConfig<TOutput>;
}

export interface CreateAgentOptions<TOutput = unknown> {
  definition: AgentDefinition<TOutput>;
  runtime: AgentRuntime;
}

export interface AgentRuntime {
  readonly provider: LLMProvider;
  readonly eventEmitter: EventEmitter;
  readonly runIdGenerator: RunIdGenerator;
  readonly clock: Clock;
}

export interface EventEmitter {
  emit(event: AgentEvent, agentId: string, actor?: string, correlationId?: string): void;
}

export interface RunIdGenerator {
  generate(): string;
}

export interface Clock {
  nowISO(): string;
}

export type InMemoryEventEmitter = EventEmitter;
export type InMemoryRunIdGenerator = RunIdGenerator;
export type InMemoryClock = Clock;
