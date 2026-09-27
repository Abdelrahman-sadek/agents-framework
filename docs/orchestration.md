# Orchestration

`@agent-farmework/orchestration`

```
                Orchestrator
                     |
       ┌─────────────┼─────────────┐
 Research Worker  Data Worker  Analysis Worker
       └─────────────┼─────────────┘
                Verification → Result
```

```ts
const orchestrator = defineOrchestrator({
  name: "quarterly-review",
  planner: staticPlanner([...]),          // or llmPlanner(...)
  workers: [
    defineWorker({ name: "research", description: "Market research", agent: researchAgent }),
    defineWorker({ name: "data", description: "Sales analysis", agent: dataAgent }),
    defineWorker({ name: "verify", description: "Checks consistency", handler: async (task) => check(task.dependencies) }),
  ],
  maxParallel: 3,                 // bounded parallelism
  maxPlanSteps: 12,
  maxReplans: 1,
  onStepFailure: "replan",        // "fail" | "continue" (partial results)
  stepTimeoutMs: 60_000,
  timeoutMs: 600_000,
  aggregate: ({ outputs }) => outputs,
  verifiers: [ruleVerifier(...)],
  events: [otelSink],
});

const result = await orchestrator.run({ input, goal, user, signal });
// { status, output, plan, steps: { [id]: PlanStepState }, replans, events, durationMs }
```

## Execution rules

- Ready steps (all dependencies completed) run in parallel, up to `maxParallel`. Steps whose dependencies failed are `SKIPPED`.
- Each step attempt has a timeout. Retryable failures are retried with backoff up to `retry.maxAttempts`.
- Cancellation (`signal`) and the orchestration timeout abort in-flight workers.
- Events: `ORCHESTRATION_STARTED`, `PLAN_CREATED`, `WORKER_SCHEDULED`, `WORKER_COMPLETED`, `WORKER_FAILED`, `REPLANNING_REQUESTED`, `VERIFICATION_COMPLETED`, `ORCHESTRATION_COMPLETED` / `ORCHESTRATION_FAILED`.

## Workers are isolated

- A worker is either a deterministic `handler` or an `agent` with **its own** model, tools, permissions and limits. Give each worker only what it needs.
- By default (`context: "isolated"`) a worker sees its task description, static input and the outputs of its dependencies, but not the original request. Use `context: "shared"` when it needs the original request.
- Agent workers run on behalf of the same user, so tool authorization still applies per user and tenant.
- A worker agent that needs human approval fails the step with `APPROVAL_REQUIRED`. Keep approval-gated actions in deterministic handlers or single agents (see the [enterprise example](../examples/enterprise-agent)).
