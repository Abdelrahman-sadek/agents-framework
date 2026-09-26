import type { JsonSchema } from "./schema.js";

/**
 * Provider-independent LLM contract. Adapters for OpenAI, Anthropic, Gemini,
 * OpenRouter, local runtimes, etc. implement `LLMProvider`; nothing in the core
 * imports a vendor SDK.
 */

export interface LLMToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments exactly as produced by the model. Untrusted input. */
  arguments: string;
}

export type LLMMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: LLMToolCall[] }
  | { role: "tool"; toolCallId: string; toolName: string; content: string; isError?: boolean };

/** What a model is told about a tool. Deliberately excludes permissions, metadata and policies. */
export interface LLMToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface LLMRequestSettings {
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: readonly string[];
}

export interface LLMRequest {
  modelId: string;
  messages: readonly LLMMessage[];
  tools?: readonly LLMToolDefinition[];
  /** Ask the model for JSON matching this schema when it supports structured output. */
  responseFormat?: { type: "json"; schema?: JsonSchema };
  settings?: LLMRequestSettings;
  signal?: AbortSignal;
  /** Correlation data an adapter may forward (e.g. as request tags). Never contains secrets. */
  metadata?: Readonly<Record<string, string>>;
}

export type LLMFinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "error" | "other";

export interface LLMTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  /** Provider-reported cost in USD, when the provider reports one. Otherwise the runtime estimates it. */
  costUsd?: number;
}

export interface LLMResponse {
  id: string;
  modelId: string;
  content: string;
  toolCalls: LLMToolCall[];
  finishReason: LLMFinishReason;
  usage: LLMTokenUsage;
  providerMetadata?: Record<string, unknown>;
}

export type LLMStreamEvent =
  | { type: "content_delta"; delta: string }
  | { type: "tool_call_delta"; id: string; name?: string; argumentsDelta: string }
  | { type: "done"; response: LLMResponse }
  | { type: "error"; error: { code: string; message: string; retryable: boolean } };

export interface ModelPricing {
  currency: "USD";
  inputPerMillionTokens: number;
  outputPerMillionTokens: number;
  cachedInputPerMillionTokens?: number;
}

/**
 * Capability metadata a model router (later phase) can reason about:
 * task requirements + capabilities + cost + latency + locality.
 */
export interface ModelCapabilities {
  providerId: string;
  modelId: string;
  deployment: "cloud" | "local";
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  toolCalling: boolean;
  structuredOutput: boolean;
  streaming: boolean;
  vision: boolean;
  embeddings: boolean;
  pricing?: ModelPricing;
  latency?: { p50Ms?: number; p95Ms?: number };
  /** Data classifications this deployment may process, e.g. ["public", "internal"]. Undefined means unrestricted. */
  allowedDataClassifications?: readonly string[];
}

export interface LLMProvider {
  /** Stable provider id referenced by `LLMModelSelector.providerId`. */
  readonly id: string;
  capabilities(modelId: string): ModelCapabilities | Promise<ModelCapabilities>;
  generate(request: LLMRequest): Promise<LLMResponse>;
  stream?(request: LLMRequest): AsyncIterable<LLMStreamEvent>;
}

/** Serializable reference to a model. Resolved to a provider by the runtime. */
export interface LLMModelSelector {
  providerId: string;
  modelId: string;
  /** Overrides or supplements what the provider reports (e.g. negotiated pricing). */
  capabilities?: Partial<Omit<ModelCapabilities, "providerId" | "modelId">>;
  /** Reserved for the model router / fallback phase. Not used by the Phase 1–2 runtime. */
  fallbacks?: readonly LLMModelSelector[];
}

export function estimateCostUsd(usage: LLMTokenUsage, pricing: ModelPricing | undefined): number {
  if (usage.costUsd !== undefined) return usage.costUsd;
  if (pricing === undefined) return 0;
  const cached = usage.cachedInputTokens ?? 0;
  const cachedRate = pricing.cachedInputPerMillionTokens ?? pricing.inputPerMillionTokens;
  return (
    ((usage.inputTokens - cached) * pricing.inputPerMillionTokens +
      cached * cachedRate +
      usage.outputTokens * pricing.outputPerMillionTokens) /
    1_000_000
  );
}
