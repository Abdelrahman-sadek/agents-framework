import { PlanningError, type LLMProvider } from "@agent-farmework/core";
import { z } from "zod";

export interface PlanStep {
  id: string;
  description: string;
  /** Name of the worker that executes the step. */
  worker: string;
  dependsOn?: readonly string[];
  /** Static input for the worker, in addition to dependency outputs. */
  input?: unknown;
  retry?: { maxAttempts: number };
  timeoutMs?: number;
}

export interface Plan {
  id: string;
  goal: string;
  revision: number;
  steps: readonly PlanStep[];
}

export type PlanStepStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "SKIPPED";

export interface PlanStepState {
  status: PlanStepStatus;
  attempts: number;
  output?: unknown;
  error?: { code: string; message: string };
  startedAt?: string;
  completedAt?: string;
}

export interface WorkerInfo {
  name: string;
  description: string;
}

export interface PlanningRequest {
  goal: string;
  input: unknown;
  workers: readonly WorkerInfo[];
  /** Present when re-planning after a failure. */
  previous?: { plan: Plan; states: Readonly<Record<string, PlanStepState>>; failure: string };
  signal?: AbortSignal;
}

/** Produces steps. Execution order, limits and validation stay with the orchestrator. */
export interface Planner {
  plan(request: PlanningRequest): Promise<readonly PlanStep[]>;
}

/** Deterministic planner: fixed steps, or a function of the request (e.g. a template per task type). */
export function staticPlanner(steps: readonly PlanStep[] | ((request: PlanningRequest) => readonly PlanStep[])): Planner {
  return { plan: async (request) => (typeof steps === "function" ? steps(request) : steps) };
}

const PlanSchema = z.object({
  steps: z
    .array(
      z.object({
        id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
        description: z.string().min(1).max(1000),
        worker: z.string(),
        dependsOn: z.array(z.string()).default([]),
      }),
    )
    .min(1),
});

/**
 * A model proposes the plan as JSON; the orchestrator validates it (schema,
 * known workers, acyclic dependencies, step limit) before anything runs.
 */
export function llmPlanner(options: { provider: LLMProvider; modelId: string; maxSteps?: number; guidance?: string }): Planner {
  return {
    async plan(request) {
      const workers = request.workers.map((w) => `- ${w.name}: ${w.description}`).join("\n");
      const replan =
        request.previous === undefined
          ? ""
          : `\n\nA previous plan failed: ${request.previous.failure}\nCompleted steps (reuse their ids to keep results): ${Object.entries(request.previous.states)
              .filter(([, s]) => s.status === "COMPLETED")
              .map(([id]) => id)
              .join(", ") || "none"}\nPrevious plan: ${JSON.stringify(request.previous.plan.steps)}`;
      const response = await options.provider.generate({
        modelId: options.modelId,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        responseFormat: { type: "json" },
        messages: [
          {
            role: "system",
            content: `You plan work for a team of workers. Use only these workers:\n${workers}\nReturn JSON {"steps":[{"id","description","worker","dependsOn":[ids]}]} with at most ${options.maxSteps ?? 8} steps. Prefer the fewest steps that achieve the goal. ${options.guidance ?? ""}`,
          },
          { role: "user", content: `Goal: ${request.goal}\nInput: ${typeof request.input === "string" ? request.input : JSON.stringify(request.input)}${replan}` },
        ],
      });
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.content.replace(/^\s*```(?:json)?|```\s*$/g, ""));
      } catch (cause) {
        throw new PlanningError("Planner returned invalid JSON", { cause });
      }
      const result = PlanSchema.safeParse(parsed);
      if (!result.success) throw new PlanningError(`Planner returned an invalid plan: ${z.prettifyError(result.error)}`);
      return result.data.steps;
    },
  };
}

/** Structural validation: unique ids, known workers and dependencies, no cycles, bounded size. */
export function validatePlan(steps: readonly PlanStep[], workers: ReadonlySet<string>, maxSteps: number): void {
  if (steps.length === 0) throw new PlanningError("Plan has no steps");
  if (steps.length > maxSteps) throw new PlanningError(`Plan has ${steps.length} steps; the limit is ${maxSteps}`);
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) throw new PlanningError(`Duplicate step id '${step.id}'`);
    ids.add(step.id);
    if (!workers.has(step.worker)) throw new PlanningError(`Step '${step.id}' uses unknown worker '${step.worker}'`);
  }
  for (const step of steps) {
    for (const dep of step.dependsOn ?? []) {
      if (!ids.has(dep)) throw new PlanningError(`Step '${step.id}' depends on unknown step '${dep}'`);
    }
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const byId = new Map(steps.map((s) => [s.id, s]));
  const visit = (id: string): void => {
    if (done.has(id)) return;
    if (visiting.has(id)) throw new PlanningError(`Plan has a dependency cycle through '${id}'`);
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep);
    visiting.delete(id);
    done.add(id);
  };
  for (const step of steps) visit(step.id);
}
