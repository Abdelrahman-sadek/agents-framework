# Core runtime

`@agent-framework/core` is the smallest stable part of the framework. It owns agent definition, the run loop, state, events, errors and limits, and it defines the **ports** everything else plugs into. It depends on no vendor SDK, database, queue, telemetry library or protocol.

```
                 ┌───────────────────────── @agent-framework/core ─────────────────────────┐
defineAgent() ──▶│ Agent ──▶ AgentRuntime (createRuntime)                                    │
                 │             │  run loop · limits · retries · cancellation · state        │
                 │             ├──▶ LLMProvider        (adapters: OpenAI, Anthropic, local…) │
                 │             ├──▶ ToolInvoker        (@agent-framework/tools ToolRuntime)  │
                 │             ├──▶ ContextManager     (Phase 4 context engine)             │
                 │             ├──▶ RunStateStore      (memory · PostgreSQL · Redis · …)     │
                 │             ├──▶ EventSink[]        (logs · OTel bridge · UI · audit)     │
                 │             └──▶ Clock · IdGenerator                                      │
                 │ DecisionEngine / DecisionProvider (deterministic decisions)              │
                 └──────────────────────────────────────────────────────────────────────────┘
```

## Composition, not globals

```ts
const runtime = createRuntime({ providers, tools, events, stateStore, context, limits, clock, ids });
```

`createRuntime` validates its options and fails fast. Agents receive the runtime explicitly. Tests build their own runtime with a scripted provider, a fixed clock and sequential ids. There is no module-level state.

## The run loop

`runtime.run(agent, options)`:

1. **Prepare.** Resolve the provider by `model.providerId` and merge its `capabilities(modelId)` with selector overrides. Fail fast if the agent has tools but there is no `ToolInvoker`, or the model can't call tools.
2. **Initialize state.** Create `AgentState` (`RUNNING`) with system instructions and the user input. Resolve limits (framework → agent → run). Link the caller's `AbortSignal` and start the run timer.
3. **Loop.**
   - Check cancellation, timeout and `maxSteps`.
   - Build the request through `ContextManager.assemble()` (pass-through by default).
   - Call `provider.generate()`, racing the abort signal. Retry `retryable` errors with backoff up to `maxLLMRetries`.
   - Record usage and estimated cost, then check `maxTokens` and `maxCost`.
   - No tool calls: validate output and finish (`COMPLETED`).
   - Otherwise, for each call: check `maxToolCalls` and send it to the `ToolInvoker`. Results become tool messages.
   - If any call needs approval, save state and return `WAITING_FOR_APPROVAL`.
   - Checkpoint state.
4. **Finish.** Errors are normalized into `FrameworkError`s and mapped to `FAILED`, `CANCELLED`, `TIMED_OUT` or `APPROVAL_EXPIRED`. Running steps are marked failed, and final state is saved.

`runtime.resume(agent, { runId, approvals })` loads the state, validates that the run is waiting and that each approval id is pending, re-invokes the decided tool calls (the tool runtime re-validates and re-authorizes them), and continues the loop.

### What the runtime never delegates to the model

Permission to run a tool, limits and budgets, retry decisions, state transitions, persistence, audit, and which tools exist. The model's output is data: tool calls are parsed and validated like any untrusted input.

## State

`AgentState` is plain, serializable data: ids, status, input, user principal, full message transcript, steps, usage, pending approvals (with the original tool call), resolved limits, metadata, output or error, the event sequence, and timestamps. Nothing an agent "knows" exists only inside a prompt.

## LLM providers

```ts
interface LLMProvider {
  readonly id: string;
  capabilities(modelId: string): ModelCapabilities | Promise<ModelCapabilities>;
  generate(request: LLMRequest): Promise<LLMResponse>;
  stream?(request: LLMRequest): AsyncIterable<LLMStreamEvent>;
}
```

Adapters must:

- map `LLMMessage`s, including assistant `toolCalls` and `tool` results, to the vendor format;
- honour `request.signal`;
- return tool call `arguments` as the raw JSON string;
- report `usage` (and `costUsd` if the vendor reports cost);
- throw `LLMError` / `RateLimitError` with `retryable: true` for transient failures.

`ModelCapabilities` describes locality (`cloud`/`local`), context window, tool calling, structured output, streaming, vision, embeddings, pricing, latency and allowed data classifications. A later model router can choose models from task requirements, capabilities, cost, latency and locality. `LLMModelSelector.fallbacks` is reserved for that.

> **Why the LLM contract lives in core:** the runtime needs it to run agents, and keeping it in the dependency-free core lets any provider adapter depend on `core` alone. `@agent-framework/llm` holds selectors today and the gateway features (routing, fallbacks, caching) later. See [ADR 018](../decisions/018-tool-system.md).

## Durability boundary

The core has no queue API. The durable-execution boundary is `RunStateStore` plus the explicit state machine:

- Every transition that matters (model turn, waiting for approval, terminal state) is checkpointed.
- `resume()` needs only the stored state and the agent definition, so it works in a new request, a new process, or on another worker.
- Caller-supplied `runId`s make run creation idempotent at the API edge.

PostgreSQL-, SQLite-, Redis- and Temporal-backed runners ([ADR 013](../decisions/013-temporal-durable-execution.md)) sit *outside* the core. They persist `AgentState`, schedule `run`/`resume` on workers, and handle leases and recovery. Nothing in the loop assumes a single process or an open HTTP request.

Current limitations: the in-memory store is the only implementation and there is no recovery runner yet. When one is added, a turn interrupted by a crash will replay from the last checkpoint, and tool idempotency keys are what protect side effects in that case. Streaming isn't wired into the loop yet.
