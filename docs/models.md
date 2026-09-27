# Models and providers

The core defines the provider contract (`LLMProvider`). Vendors are adapters.

| Adapter | Package | Covers |
| --- | --- | --- |
| `anthropicProvider()` | `@agent-farmework/provider-anthropic` | Claude via the official `@anthropic-ai/sdk` (also Bedrock / Vertex / Foundry clients through `client`) |
| `openAICompatibleProvider({ id, baseURL, apiKey })` | `@agent-farmework/llm` | OpenAI, OpenRouter, vLLM, Ollama, LM Studio, llama.cpp server |
| `createScriptedProvider`, `createRuleProvider` | `@agent-farmework/core/testing` | Deterministic tests and offline examples |

```ts
import { anthropicProvider } from "@agent-farmework/provider-anthropic";
import { models, openAICompatibleProvider, withCircuitBreaker, withFallback, withRateLimit } from "@agent-farmework/llm";

const claude = anthropicProvider();                          // reads ANTHROPIC_API_KEY
const local = openAICompatibleProvider({ id: "ollama", baseURL: "http://localhost:11434/v1" });

const runtime = createRuntime({
  providers: [
    withFallback(withCircuitBreaker(withRateLimit(claude, { requestsPerMinute: 500 })), [{ provider: local, modelId: "llama3.1:8b" }]),
    local,
  ],
});

defineAgent({ name: "assistant", model: models.anthropic("claude-opus-5"), runtime });
defineAgent({ name: "classifier", model: models.local("ollama", "llama3.1:8b"), runtime });
```

## Capabilities

Each provider reports `ModelCapabilities`: locality, context window, max output, tool calling, structured output, streaming, vision, embeddings, pricing, latency and allowed data classifications. The runtime uses them to:

- refuse tools on models without tool calling;
- send JSON Schema `responseFormat` only to models that support structured output;
- size the context budget;
- estimate cost.

Override per selector (`models.openai("gpt", { pricing: … })`) or per adapter (`models: { … }`).

## Streaming

Both adapters implement `stream()` (Anthropic SDK streaming; SSE for OpenAI-compatible servers, including tool-call deltas). Agents stream through `agent.stream()` or `onTextDelta` ([Agents › Streaming](./agents.md#streaming)).

## Model router

```ts
import { createModelRouter } from "@agent-farmework/llm";

const router = createModelRouter({
  id: "router",
  strategy: "cheapest",                 // "fastest" | "best" | "local-first"
  candidates: [
    { provider: local, modelId: "llama3.1:8b", quality: 0.6 },
    { provider: claude, modelId: "claude-sonnet-5", quality: 0.85 },
    { provider: claude, modelId: "claude-opus-5", quality: 1 },
  ],
});
createRuntime({ providers: [router] });
defineAgent({ name: "a", model: models.custom("router", "auto"), runtime });
```

Hard requirements filter candidates first: tool calling when tools are sent, structured output when a schema is requested, context size, and the request's data classification (`metadata.dataClassification` or `classify`) against each model's `allowedDataClassifications`. The strategy ranks what remains, and retryable failures fall through to the next candidate.

Other vendors that expose the Chat Completions format work through `openAICompatibleProvider` as well, including Gemini's OpenAI-compatible endpoint and Azure OpenAI deployments.

## Gateway wrappers

- `withCircuitBreaker`: after N consecutive retryable failures, fail fast (retryable) until a trial request succeeds.
- `withRateLimit`: client-side pacing with abortable waits.
- `withFallback`: on retryable failures, try other provider/model pairs in order. Non-retryable errors (bad request, auth) are never masked. `providerMetadata.servedBy` records who answered.

Retries themselves are owned by the runtime (`limits.maxLLMRetries`), so adapters disable SDK-level retries.
