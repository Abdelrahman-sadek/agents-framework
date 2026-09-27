# Tools

Tools are how agents act on the world, so they get the most protection. In this framework a model can only **request** a tool call. The `ToolRuntime` decides whether the call runs, runs it under limits, and records what happened.

```
model requests tool
  → parse arguments          (malformed JSON never executes)
  → validate input schema    (invalid arguments never execute)
  → authorize                (deterministic policy: agent + user + tenant + tool permissions)
  → approval                 (pause for a human when required)
  → rate limit
  → idempotency              (return the stored result instead of executing twice)
  → concurrency limit
  → execute                  (timeout, cancellation, retry with backoff)
  → validate output schema
  → audit record
```

## Define a tool

```ts
import { defineTool } from "@agent-framework/tools";
import { z } from "zod";

export const searchTool = defineTool({
  name: "search",                                  // [A-Za-z0-9_-]{1,64}, portable across providers
  description: "Search the internal knowledge base",
  input: z.object({
    query: z.string().min(2).describe("Search terms"),
    limit: z.number().int().max(20).default(5),
  }),
  output: z.object({ hits: z.array(z.object({ id: z.string(), title: z.string() })) }),
  permissions: ["knowledge.read"],
  timeoutMs: 5_000,
  execute: async ({ query, limit }, ctx) => kb.search(query, { limit, signal: ctx.signal }),
});
```

- `input` / `output` are Zod schemas. Input types flow into `execute`. The model receives a JSON Schema generated from `input`, and `.describe()` text becomes parameter descriptions.
- `execute(input, context)` gets validated input and a `ToolContext`: `runId`, `toolCallId`, `stepId`, `agentId`, `user`, `attempt`, and a `signal` that aborts on timeout or run cancellation.
- `defineTool` validates the definition and freezes it. Tools are branded objects, so the runtime refuses hand-made look-alikes.

### What the model sees

Only `name`, `description` and the input JSON Schema. `permissions`, `metadata`, approval rules, versions and policy details are never sent to a model, and neither are policy denial reasons (the model is only told *"Tool call was not authorized"*).

## Wire it up

```ts
const runtime = createRuntime({
  providers: [provider],
  tools: new ToolRuntime({
    policy: permissionPolicy(),     // default
    audit: myAuditSink,             // default: bounded in-memory log
    idempotency: myRedisStore,      // default: in-memory
    rateLimiter: myRedisLimiter,    // default: in-memory fixed window
    defaultTimeoutMs: 30_000,
  }),
});
```

An agent that declares tools on a runtime without a `ToolInvoker` fails at startup. There is no path that calls `execute` directly from model output.

Application code can use the same pipeline without an agent:

```ts
const result = await toolRuntime.execute(searchTool, { query: "SLA" }, { agent: serviceIdentity, user });
```

## Authorization

Authorization is deterministic code that runs before every execution, including after an approval.

### Default: `permissionPolicy()`

Each permission in `tool.permissions` must be granted to **both**:

- the **agent** (`defineAgent({ permissions })`), and
- the **user** (`run({ user: { permissions } })`), when a user is present.

A privileged agent can't lend its rights to a user, and a privileged user can't widen what an agent may do. Wildcards match namespaces: `payments.*` grants `payments.refund`, and `*` grants everything. `permissionPolicy({ requireUser: true })` denies tool calls in runs without a user.

### Custom policies

```ts
import { allOf, permissionPolicy, policy } from "@agent-framework/tools";

const sameTenant = policy("tenant-isolation", ({ user, input }) => ({
  allowed: user !== undefined && (input as { tenantId?: string }).tenantId === user.tenantId,
  reason: "Cross-tenant access",
}));

new ToolRuntime({ policy: allOf(permissionPolicy(), sameTenant) });
```

Policies see the validated input, the agent identity, the user principal (with tenant, roles and attributes), and the tool's name, kind, version, permissions and metadata. That's enough for RBAC, ABAC and data-scope rules.

`decisionPolicy(engine)` delegates to a core [`DecisionEngine`](./architecture/extension-points.md#decision-engine). It only accepts providers marked `deterministic`, so an LLM judge can never grant access, and it treats `abstain` as deny.

**Fail closed:** a policy that throws, or returns anything other than `allowed: true`, denies the call.

## Human approval

```ts
defineTool({
  name: "wire_transfer",
  // …
  approval: {
    required: ({ amount }) => amount > 10_000,   // or `true`
    expiresInMs: 30 * 60_000,
    reason: "Transfers above 10k need finance approval",
  },
});
```

- The predicate sees validated input. If it throws, approval is required (fail safe).
- An approval request carries `approvalId`, `toolCallId`, `toolName`, `argumentsHash` (SHA-256 of the canonical validated arguments), `requestedAt`, `expiresAt` and `reason`.
- A decision only applies to that exact tool call and those exact arguments. A mismatched call id, different arguments, a forged approval id or an expired request is **denied**.
- Authorization runs again before an approved call executes.
- Reviewers can also approve with **modified arguments** (validated and authorized again) or **escalate** to another reviewer ([Agents › Human approval](./agents.md#human-approval)).

The agent-side flow (pause, persist, resume) is described in [Agents › Human approval](./agents.md#human-approval).

## Reliability

| Option | Behaviour |
| --- | --- |
| `timeoutMs` (default 30 s) | Per attempt. Aborts `ctx.signal` and abandons the call even if the tool ignores the signal. Emits `TOOL_EXECUTION_TIMED_OUT`. |
| `retry: { maxAttempts, backoff, initialDelayMs, maxDelayMs }` | Retries only errors marked `retryable`. Throw `new ToolError(msg, { retryable: true })` for transient failures. |
| `retry.retryOnTimeout` | Off by default: a timed-out call may already have had side effects. Enable it only for idempotent tools. |
| `rateLimit: { maxCalls, windowMs, scope }` | Per tool, per `tenant`, or per `user`. Exceeding it returns `RATE_LIMITED` without executing. |
| `idempotency: { key, ttlMs }` | A stored success for the same key (scoped by tenant) is returned with `cached: true`. Concurrent duplicates share one execution. |
| `concurrency` | Maximum simultaneous executions of this tool in the runtime. |

Errors thrown by a tool:

- **`FrameworkError`s** (e.g. `ToolError`) keep their code, message and retryability. Write messages the model can act on.
- **Any other exception** becomes `TOOL_ERROR` with the message *"Tool 'x' failed"* and is not retried. The original message, which may contain hostnames, SQL or credentials, only goes to the audit record (`error.metadata.detail`).

Run cancellation and run timeouts propagate immediately and are never retried.

## Results

`ToolRuntime.invoke()` never throws for tool problems. It returns:

```ts
{
  status: "success" | "error" | "denied" | "approval_required" | "rejected",
  output?, error?, approval?,
  attempts, durationMs, cached,
}
```

The agent runtime turns this into a tool message for the model and an `ExecutionStep`.

## Events and audit

Events (payloads never include arguments or outputs):

```
TOOL_REQUESTED → TOOL_AUTHORIZATION_STARTED → TOOL_AUTHORIZATION_COMPLETED
  → [TOOL_APPROVAL_REQUIRED | TOOL_APPROVAL_GRANTED | TOOL_APPROVAL_REJECTED]
  → TOOL_EXECUTION_STARTED → TOOL_EXECUTION_COMPLETED | TOOL_EXECUTION_FAILED | TOOL_EXECUTION_TIMED_OUT
```

Each event carries `correlation: { stepId, llmCallId, toolCallId }` so a tool call can be traced back to the model call that requested it.

Every invocation, including denials and validation failures, writes one `ToolAuditRecord`: run, agent, user, tenant, tool, outcome, authorization decision and policy, approval decision and reviewer, attempts, duration, cache hit, error, and the validated input (`"[REDACTED]"` for tools marked `sensitive: true`). Implement `AuditSink` to write to PostgreSQL or a SIEM. Audit sinks should be durable and should not throw; errors go to `onAuditError`.

## Tool kinds and adapters

`kind` (`native`, `http`, `database`, `filesystem`, `sandbox`, `mcp`, `custom`) describes how a tool reaches the outside world, and policies can use it. HTTP, MCP and sandbox integrations are **adapters that produce ordinary `defineTool` tools**. The framework's tool representation stays the source of truth ([ADR 010](./decisions/010-mcp-integration.md), [ADR 018](./decisions/018-tool-system.md)).

Adapters:

- **MCP** ([guide](./mcp.md)): MCP server tools become framework tools; they never bypass policy, approval or audit.
- **HTTP** ([security guide](./security.md#egress-and-ssrf)): `defineHttpTool` with an egress allow-list and secret injection outside model context.
- **Sandbox** ([guide](./sandbox.md)): workspace-confined file tools and allow-listed commands behind a `SandboxRunner` port. A model never gets raw OS authority.

## Checklist for a new tool

- [ ] A precise `description`. The model chooses tools by it.
- [ ] Tight `input` schema (enums, bounds, `.strict()` where it helps) and an `output` schema.
- [ ] The least `permissions` that describe what it touches.
- [ ] `approval` for irreversible, expensive or externally visible actions.
- [ ] `idempotency` for anything that creates, sends or pays.
- [ ] `timeoutMs` that fits the dependency, and honour `ctx.signal`.
- [ ] Throw `ToolError` with `retryable: true` only for transient failures.
- [ ] `sensitive: true` if inputs contain personal or secret data.
- [ ] Tests: success, invalid input, denial, and failure.
