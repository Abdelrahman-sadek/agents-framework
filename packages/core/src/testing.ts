/**
 * Test utilities: a scripted, deterministic LLM provider.
 *
 * Import from `@agent-farmework/core/testing`. Not intended for production.
 */
import { LLMError } from "./errors.js";
import type { LLMProvider, LLMRequest, LLMResponse, LLMStreamEvent, LLMToolCall, LLMTokenUsage, ModelCapabilities } from "./llm.js";

export type ScriptedStep =
  | { text: string; usage?: Partial<LLMTokenUsage> }
  | { toolCalls: (Omit<LLMToolCall, "arguments"> & { arguments: unknown })[]; text?: string; usage?: Partial<LLMTokenUsage> }
  | { error: Error }
  | ((request: LLMRequest) => LLMResponse | Promise<LLMResponse>);

export interface ScriptedProvider extends LLMProvider {
  /** Every request the provider received, in order. */
  readonly requests: LLMRequest[];
  /** Steps not consumed yet. */
  readonly remaining: number;
}

export interface ScriptedProviderOptions {
  id?: string;
  capabilities?: Partial<ModelCapabilities>;
  /** Delay before each response, honouring the request's abort signal. */
  latencyMs?: number;
  /** Also implement `stream()`, emitting the text word by word. */
  streaming?: boolean;
}

/**
 * A provider that replays `steps` in order. Tool call arguments given as
 * objects are JSON-encoded, as a real model would send them.
 */
export function createScriptedProvider(steps: readonly ScriptedStep[], options: ScriptedProviderOptions = {}): ScriptedProvider {
  const queue = [...steps];
  const requests: LLMRequest[] = [];
  const id = options.id ?? "scripted";
  let counter = 0;

  const provider: ScriptedProvider = {
    id,
    requests,
    get remaining() {
      return queue.length;
    },
    capabilities(modelId) {
      return {
        providerId: id,
        modelId,
        deployment: "local",
        toolCalling: true,
        structuredOutput: true,
        streaming: false,
        vision: false,
        embeddings: false,
        ...options.capabilities,
      };
    },
    async generate(request) {
      requests.push(request);
      if (options.latencyMs !== undefined) await delay(options.latencyMs, request.signal);
      const step = queue.shift();
      if (step === undefined) throw new LLMError("Scripted provider has no more responses", { retryable: false });
      if (typeof step === "function") return step(request);
      if ("error" in step) throw step.error;
      counter += 1;
      const usage: LLMTokenUsage = { inputTokens: 10, outputTokens: 5, ...step.usage };
      if ("toolCalls" in step) {
        return {
          id: `${id}-${counter}`,
          modelId: request.modelId,
          content: step.text ?? "",
          toolCalls: step.toolCalls.map((c) => ({
            id: c.id,
            name: c.name,
            arguments: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments),
          })),
          finishReason: "tool_calls",
          usage,
        };
      }
      return { id: `${id}-${counter}`, modelId: request.modelId, content: step.text, toolCalls: [], finishReason: "stop", usage };
    },
  };
  if (options.streaming === true) {
    const baseCapabilities = provider.capabilities.bind(provider);
    return Object.assign(provider, {
      capabilities: (modelId: string) => ({ ...(baseCapabilities(modelId) as ModelCapabilities), streaming: true }),
      async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
        const response = await provider.generate(request);
        for (const piece of response.content.match(/\S+\s*/g) ?? []) yield { type: "content_delta", delta: piece };
        yield { type: "done", response };
      },
    });
  }
  return provider;
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

export type RuleReply = { text: string; usage?: Partial<LLMTokenUsage> } | { toolCalls: (Omit<LLMToolCall, "arguments"> & { arguments: unknown })[]; text?: string };

/**
 * A deterministic stand-in model that answers by rules over the request
 * (e.g. "if a tool result is present, summarize it"). The first rule that
 * returns a reply wins. Useful for offline examples and scenario tests.
 */
export function createRuleProvider(
  rules: readonly ((request: LLMRequest, helpers: RuleHelpers) => RuleReply | undefined)[],
  options: ScriptedProviderOptions = {},
): ScriptedProvider {
  let counter = 0;
  return createScriptedProvider(
    Array.from({ length: 10_000 }, () => (request: LLMRequest): LLMResponse => {
      const helpers = ruleHelpers(request);
      const reply = rules.reduce<RuleReply | undefined>((found, rule) => found ?? rule(request, helpers), undefined) ?? { text: "" };
      counter += 1;
      const usage: LLMTokenUsage = { inputTokens: Math.ceil(JSON.stringify(request.messages).length / 4), outputTokens: 20 };
      if ("toolCalls" in reply) {
        return {
          id: `rule-${counter}`,
          modelId: request.modelId,
          content: reply.text ?? "",
          toolCalls: reply.toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments) })),
          finishReason: "tool_calls",
          usage,
        };
      }
      return { id: `rule-${counter}`, modelId: request.modelId, content: reply.text, toolCalls: [], finishReason: "stop", usage: { ...usage, ...reply.usage } };
    }),
    options,
  );
}

export interface RuleHelpers {
  /** Text of the last user message. */
  lastUser: string;
  /** Tool results already in the conversation, by tool name (latest wins). */
  toolResults: Record<string, string>;
  /** The reference-material block, if context items were provided. */
  context: string;
  hasTool(name: string): boolean;
}

function ruleHelpers(request: LLMRequest): RuleHelpers {
  const toolResults: Record<string, string> = {};
  let lastUser = "";
  let context = "";
  for (const m of request.messages) {
    if (m.role === "tool") toolResults[m.toolName] = m.content;
    if (m.role === "user") lastUser = m.content;
    if (m.role === "system" && m.content.includes("<context>")) context = m.content;
  }
  return { toolResults, lastUser, context, hasTool: (name) => (request.tools ?? []).some((t) => t.name === name) };
}
