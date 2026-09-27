# CLI and manifests

`@agent-farmework/cli` provides the `agent` command.

| Command | Does |
| --- | --- |
| `agent create <name> [--dir agents]` | Scaffolds `agent.ts`, `agent.test.ts`, `eval.ts`, `agent.manifest.json` |
| `agent dev <module> [--input "…"]` | Runs the exported `agent` once or interactively, with a status/cost summary |
| `agent test [args]` | Runs Vitest |
| `agent evaluate <module> [--baseline f] [--out f]` | Runs the exported `evaluation`; non-zero exit on failed thresholds or regressions |
| `agent inspect <run-id> --db runs.db` | Shows persisted run state (SQLite) |
| `agent trace <run-id> --events events.jsonl` | Timeline, tokens, cost, tools, approvals, guardrails from recorded events |
| `agent dashboard --events events.jsonl [--port 4319]` | Local web UI with run list, details and timelines |
| `agent validate <manifest.json> [--registry module]` | Validates a manifest and checks references and least privilege |

## Agent manifest

```json
{
  "name": "research-agent",
  "version": "1.0.0",
  "model": { "provider": "anthropic", "model": "claude-opus-5" },
  "instructions": "Research the requested topic. Cite sources.",
  "tools": ["web_search", "database_query"],
  "context": ["handbook"],
  "guardrails": ["pii", "prompt-injection"],
  "reflection": { "verifiers": ["citations"], "maxAttempts": 1 },
  "security": { "permissions": ["knowledge.read", "database.read"] },
  "limits": { "maxSteps": 8, "maxCost": 0.5 }
}
```

```ts
const agent = defineAgentFromManifest(json, { tools, context, guardrails, verifiers }, runtime);
```

Manifests reference behaviour by name. Code lives in a registry, so manifests can be reviewed, diffed and versioned safely. `agent validate` also reports tool permissions that are not declared and declared permissions that no tool uses.
