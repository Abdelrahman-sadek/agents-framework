# Example 4 — Orchestrator and workers

```bash
pnpm example:orchestrator
```

- The plan is a validated DAG. `research` and `data` run in parallel; `verify` waits for both.
- Each worker is an agent with its own tools and permissions (only the data worker can query sales). Workers get an isolated context: their task plus dependency outputs.
- Swap `staticPlanner` for `llmPlanner({ provider, modelId })` to let a model propose the plan. The orchestrator still validates it and owns execution, retries and re-planning.
