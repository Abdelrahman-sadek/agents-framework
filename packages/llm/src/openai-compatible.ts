import {
  LLMError,
  RateLimitError,
  type LLMFinishReason,
  type LLMMessage,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type LLMStreamEvent,
  type ModelCapabilities,
} from "@agent-farmework/core";

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
      const response = await send(request, false);
      const json = (await response.json()) as ChatCompletion;
      return fromCompletion(json, request.modelId, options.id);
    },
    async *stream(request): AsyncIterable<LLMStreamEvent> {
      const response = await send(request, true);
      if (response.body === null) throw new LLMError(`${options.id}: empty stream`, { retryable: true });
      let content = "";
      let finish: string | undefined;
      let usage: ChatCompletion["usage"];
      let id = "unknown";
      let model = request.modelId;
      const calls = new Map<number, { id: string; name: string; arguments: string }>();
      for await (const data of sseData(response.body)) {
        if (data === "[DONE]") break;
        const chunk = JSON.parse(data) as {
          id?: string;
          model?: string;
          choices?: { delta?: { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
          usage?: ChatCompletion["usage"];
        };
        id = chunk.id ?? id;
        model = chunk.model ?? model;
        if (chunk.usage !== undefined && chunk.usage !== null) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (choice === undefined) continue;
        if (typeof choice.delta?.content === "string" && choice.delta.content !== "") {
          content += choice.delta.content;
          yield { type: "content_delta", delta: choice.delta.content };
        }
        for (const tc of choice.delta?.tool_calls ?? []) {
          const entry = calls.get(tc.index) ?? { id: "", name: "", arguments: "" };
          if (tc.id !== undefined) entry.id = tc.id;
          if (tc.function?.name !== undefined) entry.name += tc.function.name;
          if (tc.function?.arguments !== undefined) entry.arguments += tc.function.arguments;
          calls.set(tc.index, entry);
        }
        if (typeof choice.finish_reason === "string") finish = choice.finish_reason;
      }
      const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
      yield {
        type: "done",
        response: fromCompletion(
          { id, model, choices: [{ message: { content, tool_calls: toolCalls.map((c) => ({ id: c.id, function: { name: c.name, arguments: c.arguments } })) }, finish_reason: finish ?? "stop" }], ...(usage === undefined ? {} : { usage }) },
          request.modelId,
          options.id,
        ),
      };
    },
  };

  async function send(request: LLMRequest, stream: boolean): Promise<Response> {
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
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
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
    return response;
  }
}

interface ChatCompletion {
  id?: string;
  model?: string;
  choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; cost?: number } | null;
}

function fromCompletion(json: ChatCompletion, modelId: string, providerId: string): LLMResponse {
  const choice = json.choices?.[0];
  if (choice?.message === undefined) throw new LLMError(`${providerId}: response has no choices`);
  const usage = json.usage ?? undefined;
  return {
    id: json.id ?? "unknown",
    modelId: json.model ?? modelId,
    content: choice.message.content ?? "",
    toolCalls: (choice.message.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })),
    finishReason: FINISH[choice.finish_reason ?? ""] ?? "other",
    usage: {
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      ...(usage?.prompt_tokens_details?.cached_tokens === undefined ? {} : { cachedInputTokens: usage.prompt_tokens_details.cached_tokens }),
      ...(typeof usage?.cost === "number" ? { costUsd: usage.cost } : {}),
    },
  };
}

/** Yield the `data:` payloads of a server-sent-events body. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
  if (buffer.trim().startsWith("data:")) yield buffer.trim().slice(5).trim();
}
