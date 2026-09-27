# Planning

`@agent-farmework/orchestration`

A plan is data, not a prompt:

```ts
interface Plan { id: string; goal: string; revision: number; steps: PlanStep[] }
interface PlanStep {
  id: string; description: string; worker: string;
  dependsOn?: string[]; input?: unknown;
  retry?: { maxAttempts: number }; timeoutMs?: number;
}
```

Step state (`PENDING → RUNNING → COMPLETED | FAILED | SKIPPED`, attempts, output, error, timestamps) lives in the orchestration result.

## Planners

```ts
staticPlanner([{ id: "search", description: "...", worker: "research" }, ...]);  // deterministic templates
staticPlanner((request) => stepsFor(request.input));                           // code-generated
llmPlanner({ provider, modelId: "claude-opus-5", maxSteps: 6 });               // model-proposed
```

A model *proposes* a plan. It never controls execution. Before anything runs, every plan is validated by `validatePlan`:

- the JSON matches the plan schema;
- step ids are unique, every worker exists and every dependency exists;
- there are no dependency cycles;
- the plan has no more than `maxPlanSteps` steps.

An invalid plan fails with `PLANNING_ERROR` and nothing executes.

## Re-planning

When a step fails after its retries and `onStepFailure` is `"replan"` (the default), the planner is called again with the previous plan, the step states and the failure. Completed steps that keep the same id and worker keep their results and are not re-run. Re-planning is bounded by `maxReplans` (default 1) and emits `REPLANNING_REQUESTED` and `PLAN_CREATED` with the new revision.

See [Orchestration](./orchestration.md) for execution.
