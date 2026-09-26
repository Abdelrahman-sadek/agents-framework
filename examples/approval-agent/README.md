# Example 5 — Human approval

`Agent → Proposed action → Human approval → Tool`

```bash
pnpm example:approval
```

- `approval.required` can be a predicate over the validated input.
- The run returns `WAITING_FOR_APPROVAL` with `pendingApprovals`; state is persisted in the `RunStateStore`.
- `agent.resume({ runId, approvals })` re-validates, re-authorizes and then executes. The approval is bound
  to the tool call id and a hash of the exact arguments, and it expires.
- A rejection is reported to the model so the agent can explain it to the user.
