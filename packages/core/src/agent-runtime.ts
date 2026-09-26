import { BaseFrameworkError, AgentError, ExecutionError } from "./errors.js";
import { Agent, AgentConfig, AgentRunResult, AgentRuntime, EventEmitter, RunIdGenerator, Clock } from "./agent.js";
import { AgentEvent, toEnvelope } from "./events.js";
import { LLMRequest, LLMResponse } from "./llm.js";
import { RunLimits, AgentStatus, AgentState, ExecutionStep } from "./types.js";

export class DefaultAgentRuntime implements AgentRuntime {
  constructor(
    public readonly provider: LLMProvider,
    public readonly eventEmitter: EventEmitter,
    public readonly runIdGenerator: RunIdGenerator,
    public readonly clock: Clock,
  ) {}

  async execute(agent: Agent, runConfig: Parameters<Agent["run"]>[0]): Promise<AgentRunResult<unknown>> {
    const runId = this.runIdGenerator.generate();
    const startedAt = this.clock.nowISO();

    const initialEvents: AgentEvent[] = [];
    const emit = (event: AgentEvent) => {
      initialEvents.push(event);
      this.eventEmitter.emit(event, agent.name);
    };

    emit({
      type: "AGENT_STARTED",
      payload: { runId, agentId: agent.name, name: agent.name, input: runConfig.input },
    });

    const steps: ExecutionStep[] = [];
    let status: AgentStatus = "RUNNING";
    let output: unknown = undefined;
    let error: { code: string; message: string } | undefined;

    try {
      const response = await this.provider.generate(this.buildRequest(agent, runConfig));
      output = response.content;
      emit({
        type: "LLMCALL_COMPLETED",
        payload: {
          llmCallId: response.id,
          runId,
          agentId: agent.name,
          provider: response.modelId,
          model: response.modelId,
          tokenUsage: response.usage,
          estimatedCost: response.usage.estimatedCost,
        },
      });
      status = "COMPLETED";
    } catch (err) {
      const frameworkError = err instanceof BaseFrameworkError ? err : new AgentError(String(err), { cause: err, runId });
      error = { code: frameworkError.code, message: frameworkError.message };
      status = "FAILED";
      emit({
        type: "AGENT_FAILED",
        payload: { runId, agentId: agent.name, status: "FAILED", error },
      });
    }

    const result: AgentRunResult<unknown> = {
      runId,
      agentId: agent.name,
      status,
      output,
      error,
      steps,
      events: initialEvents,
      usage: undefined,
    };

    return result;
  }

  private buildRequest(agent: Agent, runConfig: Parameters<Agent["run"]>[0]): LLMRequest {
    const system = agent.config.system ?? "You are a helpful assistant.";
    const user = String(runConfig.input);
    return {
      modelId: agent.config.model.modelId,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      settings: {
        maxTokens: agent.config.limits?.maxTokens,
        timeout: runConfig.limits?.timeout
          ? typeof runConfig.limits.timeout === "number"
            ? runConfig.limits.timeout
            : runConfig.limits.timeout.milliseconds ?? runConfig.limits.timeout.seconds * 1000
          : undefined,
      },
    };
  }
}
