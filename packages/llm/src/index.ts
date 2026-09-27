/**
 * @agent-framework/llm — provider-independent model selectors.
 *
 * Selectors are plain, serializable references. They do not import vendor SDKs;
 * the matching `LLMProvider` adapter is registered with `createRuntime({ providers })`.
 */
import type { LLMModelSelector, ModelCapabilities } from "@agent-framework/core";

type CapabilityOverrides = LLMModelSelector["capabilities"];

function selector(providerId: string, modelId: string, capabilities?: CapabilityOverrides): LLMModelSelector {
  if (providerId === "" || modelId === "") throw new TypeError("providerId and modelId must be non-empty");
  return Object.freeze({ providerId, modelId, ...(capabilities === undefined ? {} : { capabilities }) });
}

export const models = {
  openai: (modelId: string, capabilities?: CapabilityOverrides) => selector("openai", modelId, capabilities),
  anthropic: (modelId: string, capabilities?: CapabilityOverrides) => selector("anthropic", modelId, capabilities),
  gemini: (modelId: string, capabilities?: CapabilityOverrides) => selector("gemini", modelId, capabilities),
  openrouter: (modelId: string, capabilities?: CapabilityOverrides) => selector("openrouter", modelId, capabilities),
  /** A locally hosted model (Ollama, llama.cpp, vLLM…) served by the provider registered as `providerId`. */
  local: (providerId: string, modelId: string, capabilities?: CapabilityOverrides) =>
    selector(providerId, modelId, { deployment: "local", ...capabilities }),
  /** Any provider registered under a custom id. */
  custom: (providerId: string, modelId: string, capabilities?: CapabilityOverrides) => selector(providerId, modelId, capabilities),
} as const;

/**
 * Attach ordered fallbacks to a selector.
 * @experimental Stored on the selector; the Phase 1–2 runtime does not act on it yet.
 */
export function withFallbacks(primary: LLMModelSelector, ...fallbacks: LLMModelSelector[]): LLMModelSelector {
  return Object.freeze({ ...primary, fallbacks: Object.freeze([...fallbacks]) });
}

export type { LLMModelSelector, ModelCapabilities };

export { openAICompatibleProvider, toChatMessages } from "./openai-compatible.js";
export type { OpenAICompatibleOptions } from "./openai-compatible.js";
export { withCircuitBreaker, withFallback, withRateLimit } from "./gateway.js";
export type { CircuitBreakerOptions, CircuitState, FallbackTarget } from "./gateway.js";
