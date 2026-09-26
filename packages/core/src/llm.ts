export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: LLMToolCall[];
  toolResults?: LLMToolResult[];
}

export interface LLMToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface LLMToolResult {
  toolCallId: string;
  content: string;
  name?: string;
}

export interface LLMRequest {
  modelId: string;
  messages: LLMMessage[];
  tools?: LLMToolDefinition[];
  outputSchema?: unknown;
  settings?: LLMRequestSettings;
  providerMetadata?: Record<string, unknown>;
}

export interface LLMRequestSettings {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  timeout?: number;
  stopSequences?: string[];
}

export interface LLMToolDefinition {
  name: string;
  description: string;
  parameters: unknown;
}

export type LLMStreamEvent =
  | { type: "content"; delta: string }
  | { type: "tool_call"; id: string; name: string; delta: string }
  | { type: "done"; usage?: LLMTokenUsage; finishReason?: string }
  | { type: "error"; error: { code: string; message: string } };

export interface LLMResponse {
  id: string;
  modelId: string;
  content: string;
  toolCalls: LLMToolCall[];
  finishReason: string;
  usage: LLMTokenUsage;
  providerMetadata?: Record<string, unknown>;
}

export interface LLMTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  estimatedCost?: number;
}

export interface LLMProviderCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  structuredOutput: boolean;
  maxContextTokens?: number;
}

export interface LLMProvider {
  capabilities(modelId: string): Promise<LLMProviderCapabilities>;
  generate(request: LLMRequest): Promise<LLMResponse>;
  stream?(request: LLMRequest): AsyncIterable<LLMStreamEvent>;
}

export interface LLMModelSelector {
  providerId: string;
  modelId: string;
  capabilities?: LLMProviderCapabilities;
  modelCapabilities?: ModelCapabilities;
  fallback?: LLMModelSelector;
  costPerMillionInputTokens?: number;
  costPerMillionOutputTokens?: number;
}

export class UnsupportedFeatureError extends Error {
  constructor(feature: string, modelId: string) {
    super(`Model ${modelId} does not support ${feature}`);
    this.name = "UnsupportedFeatureError";
  }
}
