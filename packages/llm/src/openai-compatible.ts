import {
  LLMError,
  RateLimitError,
  type LLMFinishReason,
  type LLMMessage,
  type LLMProvider,
  type LLMResponse,
  type ModelCapabilities,
} from "@agent-framework/core";

export interface OpenAICompatibleOptions {
  /** Provider id referenced by selectors, e.g. "openai", "openrouter", "ollama". */
  id: string;
  /** e.g. https://api.openai.com/v1, http://localhost:11434/v1 (Ollama), http://localhost:8000/v1 (vLLM). */
  baseURL: string;
  apiKey?: string;
  headers?: Readonly<Record<string, string>>;
  deployment?: "cloud" | "local";
  /** Per-model capability overrides (pricing, context window, tool support…). */
  models?: Readonly<Record<string, Partial<Omit<ModelCapabilities, "providerId" | "modelId">>>>;
  fetchImpl?: typeof fetch;
}

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

export function toChatMessages(messages: readonly LLMMessage[]): ChatMessage[] {
  return messages.map((m): ChatMessage => {
    if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    if (m.role === "assistant") {
      return {
        role: "assistant",
        content: m.content === "" ? null : m.content,
        ...(m.toolCalls === undefined || m.toolCalls.length === 0
          ? {}
          : { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments } })) }),
      };
    }
    return { role: m.role, content: m.content };
  });
}

const FINISH: Record<string, LLMFinishReason> = { stop: "stop", tool_calls: "tool_calls", length: "length", content_filter: "content_filter" };

/**
 * Adapter for the widely implemented Chat Completions wire format (OpenAI,
 * OpenRouter, Azure-compatible gateways, vLLM, Ollama, LM Studio, llama.cpp
 * server). Uses `fetch`; no SDK dependency.
 */
export function openAICompatibleProvider(options: OpenAICompatibleOptions): LLMProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.baseURL.replace(/\/$/, "")}/chat/completions`;
  return {
    id: options.id,
    capabilities(modelId) {
      return {
        providerId: options.id,
        modelId,
        deployment: options.deployment ?? (/localhost|127\.0\.0\.1/.test(options.baseURL) ? "local" : "cloud"),
        toolCalling: true,
        structuredOutput: true,
        streaming: true,
        vision: false,
        embeddings: false,
        ...options.models?.[modelId],
      };
    },
    async generate(request): Promise<LLMResponse> {
      const body = {
        model: request.modelId,
        messages: toChatMessages(request.messages),
        ...(request.tools === undefined || request.tools.length === 0
          ? {}
          : { tools: request.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) }),
        ...(request.responseFormat === undefined
          ? {}
          : { response_format: request.responseFormat.schema === undefined ? { type: "json_object" } : { type: "json_schema", json_schema: { name: "output", schema: request.responseFormat.schema } } }),
        ...(request.settings?.maxOutputTokens === undefined ? {} : { max_tokens: request.settings.maxOutputTokens }),
        ...(request.settings?.temperature === undefined ? {} : { temperature: request.settings.temperature }),
        ...(request.settings?.topP === undefined ? {} : { top_p: request.settings.topP }),
        ...(request.settings?.stopSequences === undefined ? {} : { stop: request.settings.stopSequences }),
      };
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...(options.apiKey === undefined ? {} : { authorization: `Bearer ${options.apiKey}` }), ...options.headers },
          body: JSON.stringify(body),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
      } catch (cause) {
        if (request.signal?.aborted === true) throw cause;
        throw new LLMError(`${options.id}: network error`, { cause, retryable: true });
      }
      if (!response.ok) {
        const text = (await response.text().catch(() => "")).slice(0, 500);
        if (response.status === 429) throw new RateLimitError(`${options.id}: rate limited`, { metadata: { status: 429 } });
        throw new LLMError(`${options.id}: HTTP ${response.status} ${text}`, { retryable: response.status >= 500 || response.status === 408, metadata: { status: response.status } });
      }
      const json = (await response.json()) as {
        id?: string;
        model?: string;
        choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; finish_reason?: string }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; cost?: number };
      };
      const choice = json.choices?.[0];
      if (choice?.message === undefined) throw new LLMError(`${options.id}: response has no choices`);
      return {
        id: json.id ?? "unknown",
        modelId: json.model ?? request.modelId,
        content: choice.message.content ?? "",
        toolCalls: (choice.message.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })),
        finishReason: FINISH[choice.finish_reason ?? ""] ?? "other",
        usage: {
          inputTokens: json.usage?.prompt_tokens ?? 0,
          outputTokens: json.usage?.completion_tokens ?? 0,
          ...(json.usage?.prompt_tokens_details?.cached_tokens === undefined ? {} : { cachedInputTokens: json.usage.prompt_tokens_details.cached_tokens }),
          ...(typeof json.usage?.cost === "number" ? { costUsd: json.usage.cost } : {}),
        },
      };
    },
  };
}
