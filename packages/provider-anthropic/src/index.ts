/**
 * @agent-framework/provider-anthropic — Claude models through the official Anthropic SDK.
 *
 * The only package in the repository that imports a vendor SDK; the core and
 * every other package stay provider-independent.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  LLMError,
  RateLimitError,
  type LLMFinishReason,
  type LLMMessage,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type ModelCapabilities,
  type ModelPricing,
} from "@agent-framework/core";

type Caps = Omit<ModelCapabilities, "providerId" | "modelId">;

const base: Caps = { deployment: "cloud", contextWindowTokens: 1_000_000, maxOutputTokens: 128_000, toolCalling: true, structuredOutput: true, streaming: true, vision: true, embeddings: false };
const price = (input: number, output: number): ModelPricing => ({ currency: "USD", inputPerMillionTokens: input, outputPerMillionTokens: output, cachedInputPerMillionTokens: input / 10 });

/** Known models (pricing per 1M tokens, USD). Override or extend through `models`. */
export const ANTHROPIC_MODELS: Readonly<Record<string, Caps>> = {
  "claude-opus-5": { ...base, pricing: price(5, 25) },
  "claude-opus-5-5": { ...base, pricing: price(4, 20) },
  "claude-sonnet-5": { ...base, pricing: price(2, 10) },
  "claude-fable-5-1": { ...base, pricing: price(10, 50) },
  "claude-haiku-4-5": { ...base, contextWindowTokens: 200_000, maxOutputTokens: 64_000, pricing: price(1, 5) },
};

export interface AnthropicProviderOptions {
  /** Provider id used by `models.anthropic(...)`. Default "anthropic". */
  id?: string;
  /** Inject a configured client (Bedrock/Vertex/Foundry clients expose the same surface). */
  client?: Anthropic;
  /** Default output cap per request when the agent does not set one. Default 16 000. */
  maxTokens?: number;
  /** Capabilities for models not in ANTHROPIC_MODELS, or overrides. */
  models?: Readonly<Record<string, Partial<Caps>>>;
}

type MessagesClient = Pick<Anthropic, "messages">;

/**
 * Map framework messages to the Messages API:
 * - system messages → top-level `system`
 * - assistant tool calls → `tool_use` blocks
 * - consecutive tool messages → one user turn of `tool_result` blocks (keeps parallel tool use working)
 */
export function toAnthropicMessages(messages: readonly LLMMessage[]): { system: string | undefined; messages: Anthropic.MessageParam[] } {
  const system: string[] = [];
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      system.push(m.content);
    } else if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      if (m.content !== "") content.push({ type: "text", text: m.content });
      for (const call of m.toolCalls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(call.arguments || "{}");
        } catch {
          input = {};
        }
        content.push({ type: "tool_use", id: call.id, name: call.name, input });
      }
      out.push({ role: "assistant", content });
    } else {
      const block: Anthropic.ToolResultBlockParam = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content, ...(m.isError === true ? { is_error: true } : {}) };
      const last = out.at(-1);
      if (last?.role === "user" && Array.isArray(last.content) && last.content.every((b) => b.type === "tool_result")) {
        (last.content as Anthropic.ContentBlockParam[]).push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    }
  }
  return { system: system.length > 0 ? system.join("\n\n") : undefined, messages: out };
}

const FINISH: Record<string, LLMFinishReason> = {
  end_turn: "stop",
  stop_sequence: "stop",
  tool_use: "tool_calls",
  max_tokens: "length",
  refusal: "content_filter",
};

export function fromAnthropicResponse(message: Anthropic.Message): LLMResponse {
  const text: string[] = [];
  const toolCalls: LLMResponse["toolCalls"] = [];
  for (const block of message.content) {
    if (block.type === "text") text.push(block.text);
    else if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, arguments: JSON.stringify(block.input) });
  }
  const u = message.usage;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  return {
    id: message.id,
    modelId: message.model,
    content: text.join(""),
    toolCalls,
    finishReason: FINISH[message.stop_reason ?? ""] ?? "other",
    usage: { inputTokens: u.input_tokens + cacheRead + cacheWrite, outputTokens: u.output_tokens, cachedInputTokens: cacheRead },
    providerMetadata: { stopReason: message.stop_reason, ...(message.stop_details === null || message.stop_details === undefined ? {} : { stopDetails: message.stop_details }) },
  };
}

/** Normalize SDK errors: 429 → RateLimitError, 5xx/529/network → retryable LLMError, other 4xx → non-retryable. */
export function normalizeAnthropicError(error: unknown): Error {
  if (error instanceof Anthropic.APIConnectionError) return new LLMError(`Anthropic connection error: ${error.message}`, { cause: error, retryable: true });
  if (error instanceof Anthropic.RateLimitError) return new RateLimitError("Anthropic rate limit exceeded", { cause: error, metadata: { status: 429 } });
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0;
    return new LLMError(`Anthropic API error ${status}: ${error.message}`, { cause: error, retryable: status >= 500 || status === 408 || status === 409, metadata: { status } });
  }
  return error instanceof Error ? error : new Error(String(error));
}

export function anthropicProvider(options: AnthropicProviderOptions = {}): LLMProvider {
  const id = options.id ?? "anthropic";
  // Retries are owned by the framework runtime (limits.maxLLMRetries), so the SDK's own retries are disabled.
  const client: MessagesClient = options.client ?? new Anthropic({ maxRetries: 0 });
  return {
    id,
    capabilities(modelId) {
      return { providerId: id, modelId, ...base, ...ANTHROPIC_MODELS[modelId], ...options.models?.[modelId] };
    },
    async generate(request: LLMRequest): Promise<LLMResponse> {
      const { system, messages } = toAnthropicMessages(request.messages);
      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model: request.modelId,
        max_tokens: request.settings?.maxOutputTokens ?? options.maxTokens ?? 16_000,
        messages,
        ...(system === undefined ? {} : { system }),
        ...(request.tools === undefined || request.tools.length === 0
          ? {}
          : { tools: request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Tool.InputSchema })) }),
        ...(request.settings?.stopSequences === undefined ? {} : { stop_sequences: [...request.settings.stopSequences] }),
        // Sampling parameters are rejected by current models; only sent when the agent sets them explicitly.
        ...(request.settings?.temperature === undefined ? {} : { temperature: request.settings.temperature }),
        ...(request.settings?.topP === undefined ? {} : { top_p: request.settings.topP }),
        ...(request.responseFormat?.schema === undefined
          ? {}
          : { output_config: { format: { type: "json_schema", schema: request.responseFormat.schema as Record<string, unknown> } } }),
      };
      try {
        const message = await client.messages.create(params, request.signal === undefined ? {} : { signal: request.signal });
        return fromAnthropicResponse(message);
      } catch (error) {
        throw normalizeAnthropicError(error);
      }
    },
  };
}
