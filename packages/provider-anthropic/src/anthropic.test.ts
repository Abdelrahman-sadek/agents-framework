import Anthropic from "@anthropic-ai/sdk";
import { createRuntime, defineAgent, LLMError, RateLimitError } from "@agent-farmework/core";
import { describe, expect, test, vi } from "vitest";
import { anthropicProvider, normalizeAnthropicError, toAnthropicMessages } from "./index.js";

function fakeClient(responses: Partial<Anthropic.Message>[]) {
  const create = vi.fn(async (_params: Anthropic.MessageCreateParamsNonStreaming, _opts?: { signal?: AbortSignal }) => {
    const next = responses.shift();
    if (next === undefined) throw new Error("no response");
    return { id: "msg", model: "claude-opus-5", stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 }, content: [], ...next } as Anthropic.Message;
  });
  return { client: { messages: { create } } as unknown as Anthropic, create };
}

describe("message mapping", () => {
  test("system to top level; tool calls to tool_use; consecutive tool results merged", () => {
    const { system, messages } = toAnthropicMessages([
      { role: "system", content: "Be brief." },
      { role: "user", content: "weather + time?" },
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "weather", arguments: '{"city":"Cairo"}' }, { id: "b", name: "time", arguments: "{}" }] },
      { role: "tool", toolCallId: "a", toolName: "weather", content: "31C" },
      { role: "tool", toolCallId: "b", toolName: "time", content: "err", isError: true },
    ]);
    expect(system).toBe("Be brief.");
    expect(messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "tool_use", id: "a", name: "weather", input: { city: "Cairo" } },
        { type: "tool_use", id: "b", name: "time", input: {} },
      ],
    });
    expect(messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "a", content: "31C" },
        { type: "tool_result", tool_use_id: "b", content: "err", is_error: true },
      ],
    });
  });
});

describe("anthropicProvider", () => {
  test("drives an agent through a tool call with usage, cache tokens and pricing", async () => {
    const { client, create } = fakeClient([
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "lookup", input: { q: "x" } }] as never, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } as never },
      { content: [{ type: "text", text: "Answer." }] as never },
    ]);
    const provider = anthropicProvider({ client });
    const runtime = createRuntime({
      providers: [provider],
      tools: { invoke: async () => ({ status: "success", output: { hit: 1 }, attempts: 1, durationMs: 0, cached: false }) },
    });
    const agent = defineAgent({ name: "a", model: { providerId: "anthropic", modelId: "claude-opus-5" }, instructions: "sys", tools: [{ name: "lookup", description: "d", parameters: { type: "object" } }], runtime });
    const result = await agent.run({ input: "go" });
    expect(result).toMatchObject({ status: "COMPLETED", output: "Answer.", usage: { inputTokens: 1010, cachedInputTokens: 900 } });
    // 100 uncached × $5 + 900 cached × $0.5 + 20 out × $25, per million (first call) + second call
    expect(result.usage.estimatedCostUsd).toBeCloseTo((100 * 5 + 900 * 0.5 + 20 * 25 + 10 * 5 + 5 * 25) / 1e6);
    const first = create.mock.calls[0]?.[0];
    expect(first).toMatchObject({ model: "claude-opus-5", max_tokens: 16000, system: "sys", tools: [{ name: "lookup", input_schema: { type: "object" } }] });
    expect(first).not.toHaveProperty("temperature");
    expect(create.mock.calls[1]?.[0].messages.at(-1)).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: '{"hit":1}' }] });
    expect(create.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  test("structured output uses output_config json_schema; refusal maps to content_filter", async () => {
    const { client, create } = fakeClient([{ stop_reason: "refusal", content: [] }]);
    const response = await anthropicProvider({ client }).generate({ modelId: "claude-opus-5", messages: [{ role: "user", content: "x" }], responseFormat: { type: "json", schema: { type: "object" } } });
    expect(create.mock.calls[0]?.[0].output_config).toEqual({ format: { type: "json_schema", schema: { type: "object" } } });
    expect(response.finishReason).toBe("content_filter");
  });

  test("capabilities include pricing and allow overrides", () => {
    const p = anthropicProvider({ client: fakeClient([]).client, models: { "my-model": { contextWindowTokens: 50_000 } } });
    expect(p.capabilities("claude-haiku-4-5")).toMatchObject({ contextWindowTokens: 200_000, pricing: { inputPerMillionTokens: 1 } });
    expect(p.capabilities("my-model")).toMatchObject({ contextWindowTokens: 50_000, toolCalling: true });
  });

  test("errors are normalized by retryability", () => {
    const headers = new Headers();
    expect(normalizeAnthropicError(new Anthropic.RateLimitError(429, undefined, "slow", headers))).toBeInstanceOf(RateLimitError);
    const overloaded = normalizeAnthropicError(new Anthropic.InternalServerError(529, undefined, "overloaded", headers));
    expect(overloaded).toMatchObject({ code: "LLM_ERROR", retryable: true });
    const bad = normalizeAnthropicError(new Anthropic.BadRequestError(400, undefined, "bad", headers));
    expect(bad).toMatchObject({ retryable: false, metadata: { status: 400 } });
    expect(normalizeAnthropicError(new Anthropic.APIConnectionError({ message: "reset" }))).toBeInstanceOf(LLMError);
  });
});

describe("anthropicProvider streaming", () => {
  test("yields text deltas then the final response", async () => {
    const events = [
      { type: "message_start" },
      { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } },
      { type: "message_stop" },
    ];
    const stream = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        yield* events;
      },
      finalMessage: async () => ({ id: "m", model: "claude-opus-5", stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 }, content: [{ type: "text", text: "Hello" }] }),
    }));
    const provider = anthropicProvider({ client: { messages: { stream } } as unknown as Anthropic });
    const out: unknown[] = [];
    for await (const e of provider.stream!({ modelId: "claude-opus-5", messages: [{ role: "user", content: "hi" }] })) out.push(e);
    expect(out).toEqual([
      { type: "content_delta", delta: "Hel" },
      { type: "content_delta", delta: "lo" },
      { type: "done", response: expect.objectContaining({ content: "Hello", finishReason: "stop" }) },
    ]);
  });
});
