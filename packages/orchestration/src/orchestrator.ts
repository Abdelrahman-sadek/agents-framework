import {
  CancellationError,
  ConfigurationError,
  ExecutionError,
  FrameworkError,
  PlanningError,
  RunTimeoutError,
  VerificationError,
  createEventEmitter,
  raceAbort,
  randomIds,
  sleep,
  systemClock,
  type AgentEvent,
  type Clock,
  type EventSink,
  type IdGenerator,
  type Principal,
  type SerializedError,
  type Verifier,
} from "@agent-farmework/core";
import { validatePlan, type Plan, type PlanStep, type PlanStepState, type Planner } from "./plan.js";
import type { Worker } from "./worker.js";

export interface OrchestratorConfig {
  name: string;
  planner: Planner;
  workers: readonly Worker[];
  /** Steps running at the same time. Default 4. */
  maxParallel?: number;
  /** Maximum steps in any plan. Default 20. */
  maxPlanSteps?: number;
  /** Re-plans allowed after failures. Default 1. */
  maxReplans?: number;
  /** What to do when a step fails after its retries. Default "replan". */
  onStepFailure?: "replan" | "fail" | "continue";
  /** Default per-attempt timeout for steps. */
  stepTimeoutMs?: number;
  /** Whole-orchestration timeout. Default 10 minutes. */
  timeoutMs?: number;
  /** Combine step outputs into the final result. Default: the output of the final step(s). */
  aggregate?: (context: AggregationContext) => unknown;
  /** Checks on the aggregated result (cross-agent verification, rules…). */
  verifiers?: readonly Verifier[];
  events?: readonly EventSink[];
  clock?: Clock;
  ids?: IdGenerator;
}

export interface AggregationContext {
  goal: string;
  input: unknown;
  plan: Plan;
  outputs: Readonly<Record<string, unknown>>;
}

export interface OrchestrationRunOptions {
  input: unknown;
  /** Defaults to the input when it is a string. */
  goal?: string;
  user?: Principal;
  runId?: string;
  signal?: AbortSignal;
}

export interface OrchestrationResult {
  runId: string;
  status: "COMPLETED" | "FAILED" | "CANCELLED" | "TIMED_OUT";
  output?: unknown;
  error?: SerializedError;
  plan?: Plan;
  steps: Record<string, PlanStepState>;
  replans: number;
  events: AgentEvent[];
  durationMs: number;
}

export interface Orchestrator {
  readonly name: string;
  run(options: OrchestrationRunOptions): Promise<OrchestrationResult>;
}

/**
 * The orchestrator owns execution: it validates the plan, schedules ready
 * steps in parallel (bounded), retries, times out, re-plans on failure
 * (bounded), aggregates and verifies. The planner only proposes steps.
 */
export function defineOrchestrator(config: OrchestratorConfig): Orchestrator {
  const workers = new Map(config.workers.map((w) => [w.name, w]));
  if (workers.size !== config.workers.length) throw new ConfigurationError(`Orchestrator '${config.name}': duplicate worker names`);
  if (workers.size === 0) throw new ConfigurationError(`Orchestrator '${config.name}': at least one worker is required`);
  const clock = config.clock ?? systemClock;
  const ids = config.ids ?? randomIds;
  const maxParallel = config.maxParallel ?? 4;
  const maxPlanSteps = config.maxPlanSteps ?? 20;
  const maxReplans = config.maxReplans ?? 1;
  const onFailure = config.onStepFailure ?? "replan";

  return {
    name: config.name,
    async run(options) {
      const started = Date.now();
      const runId = options.runId ?? ids.next("run");
      const goal = options.goal ?? (typeof options.input === "string" ? options.input : JSON.stringify(options.input));
      const emitter = createEventEmitter({ runId, agentId: config.name, sinks: config.events ?? [], clock, ids });
      const { emit } = emitter;

      const controller = new AbortController();
      const onAbort = (): void => controller.abort(new CancellationError("Orchestration cancelled by the caller", { runId }));
      if (options.signal?.aborted === true) onAbort();
      else options.signal?.addEventListener("abort", onAbort, { once: true });
      const timeoutMs = config.timeoutMs ?? 600_000;
      const timer = setTimeout(() => controller.abort(new RunTimeoutError(timeoutMs, { runId })), timeoutMs);
      const signal = controller.signal;

      const states: Record<string, PlanStepState> = {};
      let plan: Plan | undefined;
      let replans = 0;
      const workerInfo = config.workers.map((w) => ({ name: w.name, description: w.description }));
      const now = (): string => clock.now().toISOString();

      const makePlan = async (previous?: { failure: string }): Promise<Plan> => {
        const steps = await raceAbort(
          config.planner.plan({
            goal,
            input: options.input,
            workers: workerInfo,
            signal,
            ...(previous === undefined || plan === undefined ? {} : { previous: { plan, states: { ...states }, failure: previous.failure } }),
          }),
          signal,
        );
        validatePlan(steps, new Set(workers.keys()), maxPlanSteps);
        const next: Plan = { id: plan?.id ?? ids.next("plan"), goal, revision: (plan?.revision ?? 0) + 1, steps };
        // Keep results of completed steps that survive re-planning with the same id and worker.
        for (const step of steps) {
          const prior = plan?.steps.find((s) => s.id === step.id);
          if (!(states[step.id]?.status === "COMPLETED" && prior?.worker === step.worker)) states[step.id] = { status: "PENDING", attempts: 0 };
        }
        for (const id of Object.keys(states)) if (!steps.some((s) => s.id === id)) delete states[id];
        emit("PLAN_CREATED", { planId: next.id, stepCount: steps.length, revision: next.revision });
        return next;
      };

      const runStep = async (step: PlanStep): Promise<void> => {
        const worker = workers.get(step.worker) as Worker;
        const state = states[step.id] as PlanStepState;
        const maxAttempts = step.retry?.maxAttempts ?? 1;
        state.status = "RUNNING";
        state.startedAt = now();
        const stepStarted = Date.now();
        const dependencies: Record<string, unknown> = {};
        for (const dep of step.dependsOn ?? []) dependencies[dep] = states[dep]?.output;
        for (;;) {
          state.attempts += 1;
          emit("WORKER_SCHEDULED", { planStepId: step.id, worker: worker.name, attempt: state.attempts });
          const attemptController = new AbortController();
          const relay = (): void => attemptController.abort(signal.reason);
          signal.addEventListener("abort", relay, { once: true });
          const stepTimeout = step.timeoutMs ?? config.stepTimeoutMs;
          const attemptTimer =
            stepTimeout === undefined
              ? undefined
              : setTimeout(() => attemptController.abort(new ExecutionError(`Step '${step.id}' timed out after ${stepTimeout}ms`, { retryable: true })), stepTimeout);
          try {
            state.output = await raceAbort(
              worker.execute({
                runId,
                planStepId: step.id,
                goal,
                description: step.description,
                input: step.input,
                dependencies,
                originalInput: options.input,
                ...(options.user === undefined ? {} : { user: options.user }),
                attempt: state.attempts,
                signal: attemptController.signal,
              }),
              attemptController.signal,
            );
            state.status = "COMPLETED";
            state.completedAt = now();
            emit("WORKER_COMPLETED", { planStepId: step.id, worker: worker.name, attempts: state.attempts, durationMs: Date.now() - stepStarted });
            return;
          } catch (error) {
            if (signal.aborted) throw signal.reason;
            const normalized = FrameworkError.from(error, (m, cause) => new ExecutionError(m, { cause }));
            const willRetry = normalized.retryable && state.attempts < maxAttempts;
            emit("WORKER_FAILED", { planStepId: step.id, worker: worker.name, attempt: state.attempts, willRetry, error: { ...normalized.toJSON(), runId } });
            if (!willRetry) {
              state.status = "FAILED";
              state.completedAt = now();
              state.error = { code: normalized.code, message: normalized.message };
              return;
            }
            await sleep(Math.min(100 * 2 ** (state.attempts - 1), 2_000), signal);
          } finally {
            clearTimeout(attemptTimer);
            signal.removeEventListener("abort", relay);
          }
        }
      };

      const finish = (result: Omit<OrchestrationResult, "runId" | "steps" | "replans" | "events" | "durationMs" | "plan">): OrchestrationResult => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        return { runId, ...result, ...(plan === undefined ? {} : { plan }), steps: states, replans, events: emitter.events, durationMs: Date.now() - started };
      };

      try {
        emit("ORCHESTRATION_STARTED", { orchestrator: config.name, goal });
        plan = await makePlan();

        for (;;) {
          if (signal.aborted) throw signal.reason;
          const current: Plan = plan;
          // Skip steps whose dependencies failed or were skipped.
          for (const step of current.steps) {
            const s = states[step.id] as PlanStepState;
            if (s.status === "PENDING" && (step.dependsOn ?? []).some((d) => ["FAILED", "SKIPPED"].includes(states[d]?.status ?? ""))) s.status = "SKIPPED";
          }
          const failed = current.steps.find((s) => states[s.id]?.status === "FAILED");
          if (failed !== undefined && onFailure !== "continue") {
            const failure = `Step '${failed.id}' (${failed.worker}) failed: ${states[failed.id]?.error?.message ?? "unknown"}`;
            if (onFailure === "fail" || replans >= maxReplans) throw new ExecutionError(failure, { runId, metadata: { planStepId: failed.id } });
            replans += 1;
            emit("REPLANNING_REQUESTED", { reason: failure, revision: current.revision + 1 });
            plan = await makePlan({ failure });
            continue;
          }
          const ready = current.steps.filter(
            (s) => states[s.id]?.status === "PENDING" && (s.dependsOn ?? []).every((d) => states[d]?.status === "COMPLETED"),
          );
          if (ready.length === 0) break;
          // Bounded parallelism: run up to maxParallel ready steps, then re-evaluate.
          await Promise.all(ready.slice(0, maxParallel).map(runStep));
        }

        const completed = plan.steps.filter((s) => states[s.id]?.status === "COMPLETED");
        if (completed.length === 0) throw new ExecutionError("No plan step completed", { runId });
        const outputs = Object.fromEntries(completed.map((s) => [s.id, states[s.id]?.output]));
        let output: unknown;
        if (config.aggregate !== undefined) {
          output = config.aggregate({ goal, input: options.input, plan, outputs });
        } else {
          const sinks = completed.filter((s) => !plan?.steps.some((o) => (o.dependsOn ?? []).includes(s.id)));
          output = sinks.length === 1 ? outputs[(sinks[0] as PlanStep).id] : Object.fromEntries(sinks.map((s) => [s.id, outputs[s.id]]));
        }

        const failures: string[] = [];
        for (const verifier of config.verifiers ?? []) {
          const text = typeof output === "string" ? output : JSON.stringify(output);
          const verdict = await verifier.verify({ runId, agentId: config.name, input: options.input, text, output, contextItems: [], messages: [], signal });
          emit("VERIFICATION_COMPLETED", { verifier: verifier.name, passed: verdict.passed, attempt: 1 });
          if (!verdict.passed) failures.push(`${verifier.name}: ${verdict.feedback ?? "failed"}`);
        }
        if (failures.length > 0) throw new VerificationError(`Result failed verification: ${failures.join("; ")}`, { runId });

        emit("ORCHESTRATION_COMPLETED", { stepsCompleted: completed.length, durationMs: Date.now() - started });
        return finish({ status: "COMPLETED", output });
      } catch (error) {
        const normalized = FrameworkError.from(error, (m, cause) => new PlanningError(m, { cause }));
        const serialized = { ...normalized.toJSON(), runId };
        emit("ORCHESTRATION_FAILED", { error: serialized });
        const status = normalized instanceof CancellationError ? "CANCELLED" : normalized instanceof RunTimeoutError ? "TIMED_OUT" : "FAILED";
        for (const s of Object.values(states)) if (s.status === "RUNNING" || s.status === "PENDING") s.status = "SKIPPED";
        return finish({ status, error: serialized });
      }
    },
  };
}
