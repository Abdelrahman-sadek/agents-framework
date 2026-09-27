# ADR 020: Provider adapters and the model gateway

**Status:** Accepted

**Decision**

- Vendor SDKs live only in dedicated adapter packages. `@agent-farmework/provider-anthropic` uses the official `@anthropic-ai/sdk`, the vendor's supported client, which also accepts Bedrock, Vertex and Foundry client variants through `client`. No other package imports a vendor SDK.
- `@agent-farmework/llm` ships a dependency-free, `fetch`-based adapter for the Chat Completions wire format, because it is the common interface of OpenAI, OpenRouter and local servers (vLLM, Ollama, LM Studio).
- Gateway behaviour is composed as provider wrappers: `withCircuitBreaker`, `withRateLimit`, `withFallback`. Retries stay in the runtime (`maxLLMRetries`); adapters disable SDK retries to avoid multiplying attempts.
- Adapters normalize errors into `LLMError` / `RateLimitError` with correct `retryable` flags, and report cache-aware usage and pricing through `ModelCapabilities`.

**Consequences**

- Adding a vendor means one package implementing `LLMProvider`, with no core changes.
- A full model router (choosing models per task from capabilities, cost, latency and locality) can be built on `ModelCapabilities` plus `withFallback`. It remains future work.
