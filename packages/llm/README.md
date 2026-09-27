# @agent-framework/llm

Vendor-free model selectors, an OpenAI-compatible adapter (OpenAI, OpenRouter, vLLM, Ollama, LM Studio) and gateway wrappers (circuit breaker, rate limit, fallback). Guide: [docs/models.md](../../docs/models.md).

```ts
import { models } from "@agent-framework/llm";

models.openai("gpt-4.1-mini");
models.anthropic("claude-sonnet-5");
models.local("ollama", "llama3.1:8b");
```

A selector's `providerId` must match the `id` of an `LLMProvider` registered with `createRuntime({ providers })`. The provider contract itself lives in `@agent-framework/core`.
