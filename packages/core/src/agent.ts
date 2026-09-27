import { ConfigurationError, type SerializedError } from "./errors.js";
import type { AgentEvent } from "./events.js";
import type { Principal } from "./identity.js";
import { validateLimits } from "./limits.js";
import type { LLMModelSelector, LLMRequestSettings } from "./llm.js";
import type { JsonSchema, Schema } from "./schema.js";
import type { ContextProvider } from "./context.js";
import type { Guardrail } from "./guardrail.js";
import type { ReflectionConfig } from "./reflection.js";
import { renderSkillInstructions, resolveSkills, type Skill } from "./skill.js";
import type { AgentTool, ApprovalDecision, ApprovalRequest } from "./tool.js";
import type { AgentState, AgentStatus, ExecutionStep, RunLimits, UsageTotals } from "./types.js";

export interface AgentConfig<TOutput = string> {
  /** Stable agent id. Letters, digits, `.`, `_`, `-`; max 64 chars. */
  name: string;
  version?: string;
  description?: string;
  model: LLMModelSelector;
  instructions?: string;
  tools?: readonly AgentTool[];
  /** Schema for the final output. Without it, the output is the model's text. */
  output?: Schema<TOutput>;
  /** JSON Schema sent to models that support structured output. Derived from `output.toJSONSchema()` when available. */
  outputJsonSchema?: JsonSchema;
  /** Knowledge, memory or application context contributed once per run. */
  context?: readonly ContextProvider[];
  /** Input, tool-result and output guardrails. */
  guardrails?: readonly Guardrail[];
  /** Generate → verify → correct. Opt-in; bounded by `limits.maxReflectionAttempts`. */
  reflection?: ReflectionConfig;
  /** Composable skills. Their instructions, tools, permissions, context, guardrails and verifiers are merged in. */
  skills?: readonly Skill[];
  /** Permissions granted to the agent identity. Tools need them on both agent and user. */
  permissions?: readonly string[];
  limits?: RunLimits;
  settings?: LLMRequestSettings;
  metadata?: Readonly<Record<string, unknown>>;
  /** Binds the agent to a runtime so `agent.run()` works. Optional: `runtime.run(agent, …)` also works. */
  runtime?: AgentRuntime;
}

/** Live callbacks for one invocation (UI streaming). */
export interface StreamCallbacks {
  /** Text tokens as the model produces them (requires a provider with `stream`). */
  onTextDelta?: (delta: string, info: { llmCallId: string }) => void;
  /** Every event of this invocation, as it happens. */
  onEvent?: (event: AgentEvent) => void;
}

export type AgentStreamChunk =
  | { type: "text"; delta: string; llmCallId: string }
  | { type: "event"; event: AgentEvent }
  | { type: "result"; result: AgentRunResult<unknown> };

export interface RunOptions extends StreamCallbacks {
  input: unknown;
  /** The end user on whose behalf the agent acts. Used for authorization and tenancy. */
  user?: Principal;
  /** Caller-supplied run id (e.g. an idempotency key from an API request). Must be unique. */
  runId?: string;
  metadata?: Record<string, unknown>;
  limits?: RunLimits;
  signal?: AbortSignal;
}

export interface ResumeOptions extends StreamCallbacks {
  runId: string;
  approvals: readonly ApprovalDecision[];
  signal?: AbortSignal;
  /** Only the timeout can be changed on resume; other limits are fixed at run start. */
  timeoutMs?: number;
}

export interface RecoverOptions {
  runId: string;
  signal?: AbortSignal;
}

export interface AgentRunResult<TOutput = string> {
  runId: string;
  agentId: string;
  status: AgentStatus;
  /** Present when `status` is `COMPLETED`. */
  output?: TOutput;
  error?: SerializedError;
  steps: ExecutionStep[];
  usage: UsageTotals;
  /** Approvals a human must decide before `resume()`. Non-empty when `status` is `WAITING_FOR_APPROVAL`. */
  pendingApprovals: ApprovalRequest[];
  /** Events emitted during this invocation. */
  events: AgentEvent[];
}

export interface AgentRuntime {
  run<TOutput>(agent: Agent<TOutput>, options: RunOptions): Promise<AgentRunResult<TOutput>>;
  resume<TOutput>(agent: Agent<TOutput>, options: ResumeOptions): Promise<AgentRunResult<TOutput>>;
  /** Continue a run interrupted by a crash (state still RUNNING). */
  recover<TOutput>(agent: Agent<TOutput>, options: RecoverOptions): Promise<AgentRunResult<TOutput>>;
  getState(runId: string): Promise<AgentState | undefined>;
}

export interface Agent<TOutput = string> {
  readonly id: string;
  readonly name: string;
  readonly version: string | undefined;
  readonly config: Readonly<AgentConfig<TOutput>>;
  run(options: RunOptions): Promise<AgentRunResult<TOutput>>;
  resume(options: ResumeOptions): Promise<AgentRunResult<TOutput>>;
  recover(options: RecoverOptions): Promise<AgentRunResult<TOutput>>;
  /** Run and yield text deltas and events as they happen, then the final result. */
  stream(options: Omit<RunOptions, keyof StreamCallbacks>): AsyncIterable<AgentStreamChunk>;
  /** Returns a copy of this agent bound to another runtime. */
  withRuntime(runtime: AgentRuntime): Agent<TOutput>;
}

const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function defineAgent<TOutput = string>(input: AgentConfig<TOutput>): Agent<TOutput> {
  const config = applySkills(input);
  const where = `Agent '${String(config.name)}'`;
  if (typeof config.name !== "string" || !AGENT_NAME.test(config.name)) {
    throw new ConfigurationError(`${where}: name must match ${AGENT_NAME.source}`);
  }
  const model = config.model as LLMModelSelector | undefined;
  if (model === undefined || typeof model.providerId !== "string" || typeof model.modelId !== "string" || model.modelId === "") {
    throw new ConfigurationError(`${where}: model must be an LLMModelSelector with providerId and modelId`);
  }
  const seen = new Set<string>();
  for (const tool of config.tools ?? []) {
    if (!TOOL_NAME.test(tool.name)) throw new ConfigurationError(`${where}: invalid tool name '${tool.name}'`);
    if (seen.has(tool.name)) throw new ConfigurationError(`${where}: duplicate tool name '${tool.name}'`);
    seen.add(tool.name);
  }
  validateLimits(config.limits, where);

  const frozen: Readonly<AgentConfig<TOutput>> = Object.freeze({
    ...config,
    tools: Object.freeze([...(config.tools ?? [])]),
    permissions: Object.freeze([...(config.permissions ?? [])]),
  });

  const requireRuntime = (): AgentRuntime => {
    if (frozen.runtime === undefined) {
      throw new ConfigurationError(
        `${where} is not bound to a runtime. Pass \`runtime\` to defineAgent() or call runtime.run(agent, …).`,
      );
    }
    return frozen.runtime;
  };

  const agent: Agent<TOutput> = Object.freeze({
    id: config.name,
    name: config.name,
    version: config.version,
    config: frozen,
    run: (options: RunOptions) => requireRuntime().run(agent, options),
    resume: (options: ResumeOptions) => requireRuntime().resume(agent, options),
    recover: (options: RecoverOptions) => requireRuntime().recover(agent, options),
    stream: (options: Omit<RunOptions, keyof StreamCallbacks>) => streamRun((callbacks) => requireRuntime().run(agent, { ...options, ...callbacks })),
    withRuntime: (runtime: AgentRuntime) => defineAgent<TOutput>({ ...config, runtime }),
  });
  return agent;
}

/** Bridge callback-style streaming to an async iterable. */
export async function* streamRun(start: (callbacks: StreamCallbacks) => Promise<AgentRunResult<unknown>>): AsyncIterable<AgentStreamChunk> {
  const queue: AgentStreamChunk[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  let failure: unknown;
  const push = (chunk: AgentStreamChunk): void => {
    queue.push(chunk);
    wake?.();
  };
  start({
    onTextDelta: (delta, info) => push({ type: "text", delta, llmCallId: info.llmCallId }),
    onEvent: (event) => push({ type: "event", event }),
  }).then(
    (result) => {
      push({ type: "result", result });
      done = true;
      wake?.();
    },
    (error: unknown) => {
      failure = error;
      done = true;
      wake?.();
    },
  );
  for (;;) {
    const next = queue.shift();
    if (next !== undefined) {
      yield next;
      continue;
    }
    if (done) {
      if (failure !== undefined) throw failure;
      return;
    }
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
    wake = undefined;
  }
}

/** Merge skills into an agent config. Idempotent, so `defineAgent({ ...agent.config })` is safe. */
function applySkills<TOutput>(config: AgentConfig<TOutput>): AgentConfig<TOutput> {
  if (config.skills === undefined || config.skills.length === 0) return config;
  const skills = resolveSkills(config.skills);
  const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];
  const tools = [...(config.tools ?? [])];
  for (const skill of skills) {
    for (const tool of skill.tools ?? []) {
      const existing = tools.find((t) => t.name === tool.name);
      if (existing === undefined) tools.push(tool);
      else if (existing !== tool) throw new ConfigurationError(`Skill '${skill.name}' brings a different tool named '${tool.name}'`);
    }
  }
  let instructions = config.instructions ?? "";
  for (const skill of skills) {
    const block = renderSkillInstructions(skill);
    if (!instructions.includes(block)) instructions = instructions === "" ? block : `${instructions}\n\n${block}`;
  }
  const verifiers = unique([...(config.reflection?.verifiers ?? []), ...skills.flatMap((s) => s.verifiers ?? [])]);
  return {
    ...config,
    instructions,
    tools,
    permissions: unique([...(config.permissions ?? []), ...skills.flatMap((s) => s.permissions ?? [])]),
    context: unique([...(config.context ?? []), ...skills.flatMap((s) => s.context ?? [])]),
    guardrails: unique([...(config.guardrails ?? []), ...skills.flatMap((s) => s.guardrails ?? [])]),
    ...(verifiers.length === 0 ? {} : { reflection: { verifiers } }),
    skills,
  };
}
