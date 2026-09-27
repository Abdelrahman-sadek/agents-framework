# ADR 018: Tool system design (Phase 2)

**Status:** Accepted

**Context**

Phase 2 turns ADR 005's intent into code. The main questions were where tool contracts live, how the agent runtime reaches tools without a dependency cycle, which schema library to use, and how approvals survive a pause.

**Decisions**

1. **Core owns a tool *port*; `@agent-framework/tools` owns tools.** Core defines `AgentTool` (name, description, JSON Schema parameters) and `ToolInvoker`. The tools package implements `ToolRuntime implements ToolInvoker`. The agent runtime can therefore only reach `execute` through the invoker, and `core` stays dependency-free.
2. **Branded tools.** `defineTool` produces branded, frozen objects. `ToolRuntime` refuses anything else, so a hand-built object with an `execute` function can't bypass validation or policy.
3. **Fixed pipeline order:** parse → validate → authorize → approval → rate limit → idempotency → concurrency → execute (timeout, retry) → validate output → audit. Authorization comes before approval and runs again on resume. Approval never substitutes for authorization.
4. **Permissions are required on both agent and user.** This prevents escalation in either direction. Richer rules are `ToolPolicy`s, composable with `allOf`. Policies fail closed.
5. **Approval binding.** An `ApprovalRequest` records `toolCallId`, `toolName`, a SHA-256 hash of the canonical validated arguments, and expiry. Decisions that don't match are denied. The agent runtime persists pending approvals, including the original tool call, in `AgentState` and resumes through `runtime.resume()`.
6. **Zod v4 for tools; a structural `Schema` in core.** Zod v4 generates JSON Schema natively (no extra dependency). Core only needs `safeParse`, so agent output schemas can come from any validator.
7. **The LLM contract lives in core.** The runtime needs it, and provider adapters should depend only on `core`. `@agent-framework/llm` holds selectors now and gateway features (routing, fallbacks) later. This refines ADR 016.
8. **Error hygiene.** Non-framework exceptions from tools are reported to the model as a generic `TOOL_ERROR`. The original message goes only to audit. Policy denial reasons are not sent to the model.
9. **Retries are opt-in and conservative.** Only `retryable` framework errors are retried. Timeouts are not retried unless `retryOnTimeout` is set.

**Alternatives considered**

- *Tool runtime inside core*: simpler wiring, but it would pull Zod and policy code into the core and blur the boundary.
- *MCP tool format as the internal representation*: rejected (ADR 010).
- *Approvals stored only in the tool runtime*: would split state across two stores. The run state is the single source of truth.

**Consequences**

- One pipeline serves agents and direct application calls (`ToolRuntime.execute`).
- In-memory idempotency, rate limit and audit stores are per process. Multi-instance deployments must provide shared adapters.
- Approval "modify arguments" and escalation workflows are not implemented yet. A modified call has to go through a new tool call.
