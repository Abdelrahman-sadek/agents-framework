# Example 1 — Simple agent

`User → Agent → Tool → Answer`

```bash
pnpm example:hello
```

Shows the minimal public API: `defineTool`, `createRuntime`, `defineAgent`, `agent.run`.
The model is scripted so the example is deterministic and needs no API key; replace
`createScriptedProvider(...)` with a real `LLMProvider` adapter to use a live model.

What to look for in the output:

- the tool call passes through authorization (`TOOL_AUTHORIZATION_*`) before execution;
- every step is an event with a sequence number;
- the audit log records who called what, and why it was allowed.
