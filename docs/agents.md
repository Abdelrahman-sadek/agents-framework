# Agents

An agent is a model, instructions, a set of tools, permissions and limits, bound to a runtime. The runtime turns a run into a sequence of model calls and tool calls, enforcing every limit and recording every step.

## Define

```ts
const agent = defineAgent({
  name: "research-agent",            // stable id: letters, digits, . _ -, max 64
  version: "1.2.0",                  // optional, recorded on runs and events
  model: models.anthropic("claude-sonnet-5"),
  instructions: "Research the requested topic. Cite sources.",
  tools: [searchTool, fetchTool],
  permissions: ["knowledge.read", "web.fetch"],   // the agent identity's grants
  output: ReportSchema,              // optional: structured, validated output
  limits: { maxSteps: 6, maxToolCalls: 10, maxCost: 0.5, timeoutMs: 90_000 },
  settings: { temperature: 0.2, maxOutputTokens: 2_000 },
  runtime,                           // or call runtime.run(agent, …)
});
```

`defineAgent` validates eagerly and returns a frozen object. Invalid names, duplicate tool names or bad limits throw a `ConfigurationError` at startup, not in the middle of a request.

An agent is a definition, not a process. The same agent can run concurrently for many users, and `agent.withRuntime(other)` rebinds it, for example to a test runtime.

## Run

```ts
const result = await agent.run({
  input: "Compare vector databases for 10M documents",   // string or JSON-serializable value
  user: { userId: "u-7", tenantId: "acme", roles: ["analyst"], permissions: ["knowledge.read"] },
  runId: requestId,            // optional: caller-supplied id; duplicates are rejected
  metadata: { ticket: "OPS-12" },
  limits: { maxCost: 0.1 },    // run-level override (highest precedence)
  signal: abortController.signal,
});
```

| `result` field | Meaning |
| --- | --- |
| `status` | `COMPLETED`, `FAILED`, `WAITING_FOR_APPROVAL`, `CANCELLED`, `TIMED_OUT`, `APPROVAL_EXPIRED` |
| `output` | Final answer (string, or schema-typed data). Present only when `COMPLETED`. |
| `error` | Serialized `FrameworkError` with `code`, `category`, `retryable`, `runId` |
| `steps` | One entry per model call and tool call, with status, attempts and errors |
| `usage` | Tokens, estimated cost (USD), model calls, tool calls |
| `pendingApprovals` | Approvals a human must decide before `resume()` |
| `events` | Events emitted during this invocation |

Runs don't throw for runtime failures; they end with a status. Only configuration mistakes throw.

### The loop

```
AGENT_STARTED
  └─ repeat until the model answers without tool calls:
       check cancellation / timeout / maxSteps
       LLM call (with retries for retryable provider errors)
       check maxTokens / maxCost
       for each requested tool call: check maxToolCalls → ToolInvoker
       if any call needs approval → WAITING_FOR_APPROVAL (state persisted) and return
  └─ validate output → AGENT_COMPLETED
```

Tool failures, denials and invalid arguments are returned to the model as tool messages with `isError: true`, so it can correct itself or explain the problem. They do not fail the run. Limits, cancellation, timeouts and provider errors do.

## Limits

Every run is bounded. Limits resolve as **framework defaults → agent → run**.

| Limit | Default | Enforced |
| --- | --- | --- |
| `maxSteps` | 10 | before each model call |
| `maxToolCalls` | 25 | before each tool call, including denied ones |
| `maxTokens` | none | after each model call (input + output) |
| `maxCost` | none | after each model call, USD, from provider pricing |
| `timeoutMs` | 120 000 | wall clock per `run()` / `resume()` |
| `maxLLMRetries` | 2 | per model call, retryable errors only |

Exceeding a limit emits `LIMIT_EXCEEDED` and fails the run with `LIMIT_EXCEEDED` (`metadata.limitType`).

Set framework-wide defaults with `createRuntime({ limits })`.

## Cancellation and timeouts

Pass an `AbortSignal`. The runtime stops at the next boundary and also abandons an in-flight model or tool call, even if the provider or tool ignores the signal. Tools receive the signal as `context.signal` so they can stop their own work.

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 5_000);
const result = await agent.run({ input, signal: controller.signal }); // status: "CANCELLED"
```

`timeoutMs` produces `TIMED_OUT`. Either way, steps that were in progress are marked `FAILED`.

## Structured output

```ts
const Report = z.object({ summary: z.string(), findings: z.array(z.string()), confidence: z.number().min(0).max(1) });
const agent = defineAgent({ name: "analyst", model, output: Report, runtime });
const result = await agent.run({ input: "…" });
if (result.status === "COMPLETED") result.output.findings; // typed
```

When `output` is set, the runtime asks models that support it for JSON (`responseFormat`), parses the final answer (a fenced ```json block is accepted) and validates it. If it is still invalid after the allowed corrections, the run fails with `OUTPUT_VALIDATION_ERROR`.

Any object with a Zod-compatible `safeParse` works as a schema; the core does not depend on Zod.

Invalid output is sent back to the model with the validation error and retried (`OUTPUT_VALIDATION_FAILED`, up to `limits.maxOutputCorrections`, default 1). Zod schemas also provide the JSON Schema used as the provider `responseFormat`; set `outputJsonSchema` for other validators.

## Human approval

When a tool requires approval, the run pauses:

```ts
const paused = await agent.run({ input: "Refund order 7", user });
// paused.status === "WAITING_FOR_APPROVAL"
// paused.pendingApprovals: [{ approvalId, toolName, argumentsHash, expiresAt, reason }]

const done = await agent.resume({
  runId: paused.runId,
  approvals: [{ approvalId, decision: "approved", decidedBy: "finance-lead" }],
});
```

- State is saved in the runtime's `RunStateStore` so `resume()` can happen in another request. With a durable store adapter, it can also happen in another process.
- On resume the tool call is **re-validated and re-authorized** before it executes. Approval never replaces authorization.
- The approval only covers the original tool call and arguments (see [Tools › Approval](./tools.md#human-approval)).
- `rejected` tells the model the action was declined and the run continues. An expired approval ends the run with `APPROVAL_EXPIRED`.
- Approvals you don't decide yet stay pending, and `resume()` returns `WAITING_FOR_APPROVAL` again.
- `decision: "modified"` with `modifiedArguments` runs the call with the reviewer's arguments. They are validated and authorized again, and the audit records `modified`.
- `decision: "escalated"` with `escalateTo` keeps the call pending, appends the reviewer to `approval.escalatedTo` and emits `TOOL_APPROVAL_ESCALATED`.

## State

Every run has an explicit, serializable `AgentState`: input, user, messages, steps, usage, pending approvals, resolved limits, output or error, and an event sequence counter. It is saved at checkpoints (after every model turn, when waiting, and at the end):

```ts
const state = await runtime.getState(runId);
```

The default store is in-memory. Production deployments provide a durable `RunStateStore` (see [Core runtime › Durability](./architecture/core-runtime.md#durability-boundary)).

## Streaming

```ts
for await (const chunk of agent.stream({ input: "Explain the refund policy" })) {
  if (chunk.type === "text") process.stdout.write(chunk.delta);      // tokens as they arrive
  else if (chunk.type === "event") ui.push(chunk.event);             // live lifecycle events
  else console.log("\n", chunk.result.status);                       // final AgentRunResult
}
// or callbacks: agent.run({ input, onTextDelta: (d) => …, onEvent: (e) => … })
```

Streaming is used when the provider implements `stream` and reports `streaming: true`; otherwise the run falls back to `generate`. Limits, tools, guardrails and verification behave the same either way.

## Skills

`defineAgent({ skills: [orderSupport] })` merges reusable capabilities: instructions, tools, permissions, context, guardrails and verifiers. See [Skills](./skills.md).

## Context, guardrails and reflection

```ts
defineAgent({
  ...,
  context: [handbook.asContextProvider(), memory.asContextProvider()],   // see context.md, knowledge.md, memory.md
  guardrails: [piiGuardrail(), promptInjectionGuardrail()],             // see guardrails.md
  reflection: { verifiers: [citationVerifier()] },                      // see reflection.md
});
```

## Crash recovery

If the process running a run dies, its state stays `RUNNING`. `agent.recover({ runId })` (or `runtime.recover`) re-invokes the tool calls of the last model turn that have no recorded result, then continues. `AgentWorker` in `@agent-farmework/production` does this automatically ([Production](./production.md)).

## Testing agents

```ts
import { createScriptedProvider } from "@agent-farmework/core/testing";

const provider = createScriptedProvider([
  { toolCalls: [{ id: "c1", name: "get_order", arguments: { orderId: "1" } }] },
  { text: "Order 1 has shipped." },
]);
const runtime = createRuntime({ providers: [provider], tools: new ToolRuntime(), ids: sequentialIds() });
// … assert on result.status, result.steps, provider.requests
```

Steps can also be `{ error }` or a function of the request. `sequentialIds()` makes run, step and event ids predictable for snapshots.
