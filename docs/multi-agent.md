# Multi-agent systems

`@agent-framework/orchestration`

Multi-agent is optional. Start with **one agent and good tools**, then add an orchestrator when the work splits into independent, verifiable steps. Use agent-to-agent delegation only when a specialist needs its own model, tools or permissions.

| Pattern | API | Use when |
| --- | --- | --- |
| Supervisor / specialists | `supervisor({ specialists: [{ agent, description }] })` | A generalist routes subtasks to specialists |
| Delegation | `agentAsTool(agent, { description, maxDepth })` | One agent occasionally asks another |
| Worker pool / hierarchical | `defineOrchestrator` + `defineWorker({ agent })` | Planned, parallel work with dependencies |
| Pipeline | `runPipeline([draft, edit, review], { input })` | Each stage transforms the previous output |
| Parallel / debate | `runParallel([optimist, pessimist], { input, aggregate })` | Independent opinions, then combine |
| Cross-agent verification | `agentVerifier(reviewer)` | A separate agent reviews the answer |

## Controls against uncontrolled multi-agent systems

- **Delegation goes through the tool runtime.** It is validated, authorized (`permissions` on `agentAsTool`), audited and counted against `maxToolCalls`.
- **Depth is bounded** (`maxDepth`, default 2), tracked with `AsyncLocalStorage` across nested runs. Exceeding it fails the delegation with `LIMIT_EXCEEDED`.
- **Delegates act for the same user.** A delegate cannot see or do more than that user may.
- **Every run keeps its own limits** (steps, tokens, cost, time) and its own event stream (`metadata.parentRunId`, `delegatedBy`).
- **Isolated context by default.** A delegate receives a self-contained task, not the caller's transcript.
