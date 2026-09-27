# Models and providers

The core defines the provider contract (`LLMProvider`). Vendors are adapters.

| Adapter | Package | Covers |
| --- | --- | --- |
| `anthropicProvider()` | `@agent-framework/provider-anthropic` | Claude via the official `@anthropic-ai/sdk` (also Bedrock / Vertex / Foundry clients through `client`) |
| `openAICompatibleProvider({ id, baseURL, apiKey })` | `@agent-framework/llm` | OpenAI, OpenRouter, vLLM, Ollama, LM Studio, llama.cpp server |
| `createScriptedProvider`, `createRuleProvider` | `@agent-framework/core/testing` | Deterministic tests and offline examples |

```ts
import { anthropicProvider } from "@agent-framework/provider-anthropic";
import { models, openAICompatibleProvider, withCircuitBreaker, withFallback, withRateLimit } from "@agent-framework/llm";

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

## Gateway wrappers

- `withCircuitBreaker`: after N consecutive retryable failures, fail fast (retryable) until a trial request succeeds.
- `withRateLimit`: client-side pacing with abortable waits.
- `withFallback`: on retryable failures, try other provider/model pairs in order. Non-retryable errors (bad request, auth) are never masked. `providerMetadata.servedBy` records who answered.

Retries themselves are owned by the runtime (`limits.maxLLMRetries`), so adapters disable SDK-level retries.
