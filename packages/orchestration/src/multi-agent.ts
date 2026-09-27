import { AsyncLocalStorage } from "node:async_hooks";
import {
  LimitExceededError,
  ToolError,
  defineAgent,
  type Agent,
  type AgentConfig,
  type AgentRunResult,
  type Principal,
  type Verifier,
} from "@agent-framework/core";
import { defineTool, type AnyTool } from "@agent-framework/tools";
import { z } from "zod";

const delegationDepth = new AsyncLocalStorage<number>();

/** Current delegation depth (0 outside any delegated agent). */
export function currentDelegationDepth(): number {
  return delegationDepth.getStore() ?? 0;
}

export interface AgentAsToolOptions {
  name?: string;
  description: string;
  /** Maximum nesting of agents calling agents. Default 2. Prevents uncontrolled spawning. */
  maxDepth?: number;
  /** Permissions the *calling* agent and user need to delegate. */
  permissions?: readonly string[];
  timeoutMs?: number;
}

/**
 * Expose an agent as a tool, so a supervisor can delegate. Delegation goes
 * through the tool runtime (validation, authorization, audit), the delegate
 * runs with its own tools and permissions on behalf of the same user, and
 * nesting depth is bounded.
 */
export function agentAsTool(agent: Agent<unknown>, options: AgentAsToolOptions): AnyTool {
  const maxDepth = options.maxDepth ?? 2;
  return defineTool({
    name: options.name ?? `ask_${agent.name.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 64),
    description: options.description,
    kind: "custom",
    permissions: options.permissions ?? [],
    timeoutMs: options.timeoutMs ?? 120_000,
    input: z.object({ task: z.string().min(1).describe("A complete, self-contained description of the subtask") }),
    execute: async ({ task }, ctx) => {
      const depth = currentDelegationDepth() + 1;
      if (depth > maxDepth) throw new LimitExceededError("steps", maxDepth, depth, { metadata: { reason: "delegation depth" } });
      const result = await delegationDepth.run(depth, () =>
        agent.run({
          input: task,
          ...(ctx.user === undefined ? {} : { user: ctx.user }),
          signal: ctx.signal,
          metadata: { delegatedBy: ctx.agentId, parentRunId: ctx.runId, delegationDepth: depth },
        }),
      );
      if (result.status !== "COMPLETED") {
        throw new ToolError(`Delegate '${agent.name}' ended with ${result.status}${result.error === undefined ? "" : `: ${result.error.message}`}`, {
          retryable: false,
        });
      }
      return result.output;
    },
  });
}

export interface SupervisorConfig extends Omit<AgentConfig<unknown>, "tools"> {
  specialists: readonly { agent: Agent<unknown>; description: string; permissions?: readonly string[] }[];
  /** Extra tools the supervisor may use directly. */
  tools?: readonly AnyTool[];
  maxDelegationDepth?: number;
}

/** Supervisor pattern: an agent whose tools are specialist agents. */
export function supervisor(config: SupervisorConfig): Agent<unknown> {
  const { specialists, maxDelegationDepth, tools, ...rest } = config;
  return defineAgent({
    ...rest,
    tools: [
      ...(tools ?? []),
      ...specialists.map((s) =>
        agentAsTool(s.agent, { description: s.description, ...(s.permissions === undefined ? {} : { permissions: s.permissions }), ...(maxDelegationDepth === undefined ? {} : { maxDepth: maxDelegationDepth }) }),
      ),
    ],
  });
}

export interface PatternRunOptions {
  input: unknown;
  user?: Principal;
  signal?: AbortSignal;
}

export interface PatternResult {
  status: "COMPLETED" | "FAILED";
  output?: unknown;
  results: AgentRunResult<unknown>[];
}

/** Pipeline pattern: each agent's output is the next agent's input. Stops at the first failure. */
export async function runPipeline(agents: readonly Agent<unknown>[], options: PatternRunOptions): Promise<PatternResult> {
  const results: AgentRunResult<unknown>[] = [];
  let input = options.input;
  for (const agent of agents) {
    const result = await agent.run({ input, ...(options.user === undefined ? {} : { user: options.user }), ...(options.signal === undefined ? {} : { signal: options.signal }) });
    results.push(result);
    if (result.status !== "COMPLETED") return { status: "FAILED", results };
    input = result.output;
  }
  return { status: "COMPLETED", output: input, results };
}

/** Parallel (fan-out/fan-in) pattern: all agents get the same input; `aggregate` combines outputs. */
export async function runParallel(
  agents: readonly Agent<unknown>[],
  options: PatternRunOptions & { aggregate?: (outputs: Record<string, unknown>) => unknown; requireAll?: boolean },
): Promise<PatternResult> {
  const results = await Promise.all(
    agents.map((agent) =>
      agent.run({ input: options.input, ...(options.user === undefined ? {} : { user: options.user }), ...(options.signal === undefined ? {} : { signal: options.signal }) }),
    ),
  );
  const ok = results.filter((r) => r.status === "COMPLETED");
  if (ok.length === 0 || (options.requireAll !== false && ok.length !== results.length)) return { status: "FAILED", results };
  const outputs = Object.fromEntries(ok.map((r) => [r.agentId, r.output]));
  return { status: "COMPLETED", output: options.aggregate === undefined ? outputs : options.aggregate(outputs), results };
}

/**
 * Cross-agent verification: a separate reviewer agent (its own model and
 * instructions) must return `{ passed, feedback }`.
 */
export function agentVerifier(reviewer: Agent<unknown>, options: { name?: string } = {}): Verifier {
  const Verdict = z.object({ passed: z.boolean(), feedback: z.string().optional() });
  return {
    name: options.name ?? `agent:${reviewer.name}`,
    async verify({ input, text, contextItems, signal }) {
      const result = await reviewer.run({
        input: `Review the answer. Reply with JSON {"passed": boolean, "feedback": string}.\n\nQuestion: ${typeof input === "string" ? input : JSON.stringify(input)}\n\nSources:\n${contextItems.map((c, i) => `[${i + 1}] ${c.content}`).join("\n") || "(none)"}\n\nAnswer:\n${text}`,
        signal,
      });
      const parsed = Verdict.safeParse(typeof result.output === "string" ? safeJson(result.output) : result.output);
      if (result.status !== "COMPLETED" || !parsed.success) return { passed: false, feedback: "Reviewer did not return a usable verdict" };
      return { passed: parsed.data.passed, ...(parsed.data.feedback === undefined ? {} : { feedback: parsed.data.feedback }) };
    },
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
