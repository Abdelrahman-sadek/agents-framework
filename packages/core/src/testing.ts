/**
 * Test utilities: a scripted, deterministic LLM provider.
 *
 * Import from `@agent-framework/core/testing`. Not intended for production.
 */
import { LLMError } from "./errors.js";
import type { LLMProvider, LLMRequest, LLMResponse, LLMToolCall, LLMTokenUsage, ModelCapabilities } from "./llm.js";

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

  return {
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
