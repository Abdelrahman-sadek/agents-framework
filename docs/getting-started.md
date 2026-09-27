# Getting started

This guide takes you from a clone to a running agent that calls a tool.

## 1. Install

As a dependency, from GitHub Packages:

```bash
# .npmrc (needs a GitHub token with read:packages)
@agent-farmework:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```bash
npm install @agent-farmework/core @agent-farmework/tools @agent-farmework/llm zod
```

Or from source:

```bash
git clone https://github.com/agent-farmework/agents-framework.git
cd agents-framework
corepack enable
pnpm install
pnpm check
```

Requirements: Node.js ≥ 20.3 and pnpm 10 (through Corepack).

## 2. Run the examples

```bash
pnpm example:hello      # User → Agent → Tool → Answer
pnpm example:approval   # Agent → Proposed action → Human approval → Tool
```

Both use a scripted model (`@agent-farmework/core/testing`), so they run offline and always give the same output.

## 3. Build your first agent

```ts
import { createRuntime, defineAgent } from "@agent-farmework/core";
import { models } from "@agent-farmework/llm";
import { ToolRuntime, defineTool } from "@agent-farmework/tools";
import { z } from "zod";

// A tool: typed, validated, permission-gated.
const getOrder = defineTool({
  name: "get_order",
  description: "Look up an order by id",
  input: z.object({ orderId: z.string() }),
  output: z.object({ orderId: z.string(), status: z.enum(["open", "shipped", "delivered"]) }),
  permissions: ["orders.read"],
  execute: async ({ orderId }) => orders.find(orderId),
});

// An explicit runtime. Nothing is global.
const runtime = createRuntime({
  providers: [myProvider],      // an LLMProvider adapter (see below)
  tools: new ToolRuntime(),
});

const agent = defineAgent({
  name: "order-assistant",
  model: models.openai("gpt-4.1-mini"),
  instructions: "Answer questions about orders. Always look orders up; never guess.",
  tools: [getOrder],
  permissions: ["orders.read"],
  runtime,
});

const result = await agent.run({
  input: "Where is order 1234?",
  user: { userId: "u-1", tenantId: "acme", permissions: ["orders.read"] },
});

console.log(result.status, result.output);
```

`result` always resolves; it doesn't throw for model or tool failures. Check `result.status` (`COMPLETED`, `FAILED`, `WAITING_FOR_APPROVAL`, `CANCELLED`, `TIMED_OUT`, …) and `result.error`. Only developer mistakes, such as an unknown provider or a missing tool runtime, throw a `ConfigurationError`.

## 4. Connect a model

The framework ships no vendor SDKs. A provider is a small adapter implementing `LLMProvider`:

```ts
import type { LLMProvider } from "@agent-farmework/core";

export const myProvider: LLMProvider = {
  id: "openai", // matches models.openai(...).providerId
  capabilities: (modelId) => ({
    providerId: "openai", modelId, deployment: "cloud",
    toolCalling: true, structuredOutput: true, streaming: true, vision: true, embeddings: false,
    pricing: { currency: "USD", inputPerMillionTokens: 0.4, outputPerMillionTokens: 1.6 },
  }),
  async generate(request) {
    // Map request.messages / request.tools to your vendor's API, honour request.signal,
    // and map the reply back to LLMResponse. Throw LLMError({ retryable: true }) for 429/5xx.
  },
};
```

Ready-made adapters: `anthropicProvider()` from `@agent-farmework/provider-anthropic` (official SDK) and `openAICompatibleProvider({ id, baseURL, apiKey })` from `@agent-farmework/llm` (OpenAI, OpenRouter, vLLM, Ollama, LM Studio). See [Models and providers](./models.md), and [Core runtime › LLM providers](./architecture/core-runtime.md#llm-providers) for the contract.

## 5. Observe what happened

```ts
import { InMemoryEventSink } from "@agent-farmework/core";

const events = new InMemoryEventSink();
const runtime = createRuntime({ providers: [myProvider], tools: new ToolRuntime(), events });
// … run …
for (const e of events.events) console.log(e.sequence, e.type, e.correlation);
```

Tool calls are also written to the tool runtime's audit sink (`new ToolRuntime({ audit })`).

## Next

- [Examples](./examples/README.md): research, RAG, orchestrator, approval and enterprise agents.
- `pnpm --filter @agent-farmework/cli build && npx agent create my-agent` scaffolds a new agent ([CLI](./cli.md)).

- [Agents guide](./agents.md): limits, cancellation, structured output, approvals, state.
- [Tools guide](./tools.md): permissions, approval, retries, idempotency, rate limits, audit.
- [Architecture](./architecture/README.md)
