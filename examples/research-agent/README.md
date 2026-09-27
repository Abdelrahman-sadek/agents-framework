# Example 2 — Research agent

`User → Plan → Search → Retrieve → Analyze → Verify → Report`

```bash
pnpm example:research
```

- `llmPlanner` proposes steps. The orchestrator validates them (known workers, acyclic, bounded) before anything runs.
- The searcher is a small, cheap model with one tool (a knowledge-base search that returns citations).
- The analyst returns a typed `Report`. It is validated against the schema and checked by a rule verifier; failures trigger a correction round.
