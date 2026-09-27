import { AgentError, ApprovalRequiredError, type Agent, type Principal } from "@agent-framework/core";

export interface WorkerTask {
  runId: string;
  planStepId: string;
  goal: string;
  description: string;
  /** Static step input. */
  input: unknown;
  /** Outputs of the steps this one depends on, by step id. */
  dependencies: Readonly<Record<string, unknown>>;
  /** Original orchestration input; only passed to workers with `context: "shared"`. */
  originalInput?: unknown;
  user?: Principal;
  attempt: number;
  signal: AbortSignal;
}

export interface Worker {
  readonly name: string;
  readonly description: string;
  execute(task: WorkerTask): Promise<unknown>;
}

export interface WorkerConfig {
  name: string;
  description: string;
  /**
   * `isolated` (default): the worker sees only its task and dependency outputs.
   * `shared`: it also sees the original orchestration input.
   */
  context?: "isolated" | "shared";
  /** Deterministic handler, or… */
  handler?: (task: WorkerTask) => Promise<unknown> | unknown;
  /** …an agent with its own model, tools, permissions and limits. */
  agent?: Agent<unknown>;
}

export function renderTask(task: WorkerTask): string {
  const parts = [`Overall goal: ${task.goal}`, `Your task: ${task.description}`];
  if (task.input !== undefined) parts.push(`Task input: ${JSON.stringify(task.input)}`);
  if (task.originalInput !== undefined) parts.push(`Original request: ${typeof task.originalInput === "string" ? task.originalInput : JSON.stringify(task.originalInput)}`);
  const deps = Object.entries(task.dependencies);
  if (deps.length > 0) parts.push(`Results from earlier steps:\n${deps.map(([id, out]) => `- ${id}: ${typeof out === "string" ? out : JSON.stringify(out)}`).join("\n")}`);
  return parts.join("\n\n");
}

/** A worker is isolated by default and has exactly the tools and permissions of its agent. */
export function defineWorker(config: WorkerConfig): Worker {
  if ((config.handler === undefined) === (config.agent === undefined)) {
    throw new TypeError(`Worker '${config.name}' needs exactly one of handler or agent`);
  }
  const shared = config.context === "shared";
  return {
    name: config.name,
    description: config.description,
    async execute(task) {
      const visible: WorkerTask = shared ? task : { ...task, originalInput: undefined };
      if (config.handler !== undefined) return config.handler(visible);
      const agent = config.agent as Agent<unknown>;
      const result = await agent.run({
        input: renderTask(visible),
        ...(task.user === undefined ? {} : { user: task.user }),
        signal: task.signal,
        metadata: { orchestrationRunId: task.runId, planStepId: task.planStepId },
      });
      if (result.status === "COMPLETED") return result.output;
      if (result.status === "WAITING_FOR_APPROVAL") {
        throw new ApprovalRequiredError(`Worker '${config.name}' needs a human approval (run ${result.runId})`, { metadata: { runId: result.runId } });
      }
      throw new AgentError(`Worker '${config.name}' ended with ${result.status}: ${result.error?.message ?? "unknown error"}`, {
        retryable: result.error?.retryable ?? false,
        metadata: { runId: result.runId, code: result.error?.code },
      });
    },
  };
}
