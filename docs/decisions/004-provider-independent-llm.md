# ADR 004: Provider-independent LLM architecture

**Status:** Accepted

**Context**

The framework must not be tightly coupled to one LLM vendor. Enterprise users will have different provider choices, compliance constraints, cost constraints, and existing contracts. The framework should support model selection, streaming, structured output, tool calling, token usage, retries, timeouts, rate limits, cost tracking, and error normalization without placing provider APIs throughout the core.

**Decision**

Introduce an `LLMProvider` abstraction with adapter implementations for each provider.

The gateway normalizes:

- message formats
- streaming events
- tool call representations
- structured output handling
- token usage metadata
- error types
- retry and timeout behavior
- fallback behavior

Provider-specific code lives in adapters, not in core runtime logic.

**Design rules**

- Core depends on the provider interface, not on a vendor SDK.
- Provider capabilities are configurable and queryable where relevant.
- The framework should not assume every provider supports every feature.
- Provider adapters may wrap vendor SDKs, but that fact is internal to the adapter.

**Alternatives considered**

- Direct OpenAI/Anthropic/Gemini imports in the runtime
- A thin wrapper that still encodes vendor-specific choices in the core
- One canonical provider with a switch for others

**Consequences**

- Vendor independence is preserved at the architectural level.
- New providers can be added as adapters.
- Normalization is a real ongoing cost: providers differ in streaming, tool calling, error models, and structured output support.
- Some features may only be available on some providers; the framework should express capability differences honestly rather than pretending they do not exist.
