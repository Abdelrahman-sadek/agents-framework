import { LLMError } from "@agent-framework/core";
import { createScriptedProvider } from "@agent-framework/core/testing";
import { describe, expect, test, vi } from "vitest";
import { openAICompatibleProvider } from "./openai-compatible.js";
import { createModelRouter } from "./router.js";

const pricing = (i: number) => ({ currency: "USD" as const, inputPerMillionTokens: i, outputPerMillionTokens: i * 5 });

describe("model router", () => {
  const cheapLocal = createScriptedProvider([{ text: "local" }, { text: "local" }], { id: "local", capabilities: { deployment: "local", toolCalling: false, contextWindowTokens: 1200, pricing: pricing(0), allowedDataClassifications: ["public", "internal", "restricted"] } });
  const mid = createScriptedProvider([{ text: "mid" }, { text: "mid" }, { text: "mid" }], { id: "mid", capabilities: { deployment: "cloud", pricing: pricing(2), latency: { p50Ms: 400 }, allowedDataClassifications: ["public", "internal"] } });
  const big = createScriptedProvider([{ text: "big" }, { text: "big" }], { id: "big", capabilities: { deployment: "cloud", pricing: pricing(5), latency: { p50Ms: 900 } } });
  const req = { modelId: "auto", messages: [{ role: "user" as const, content: "hi" }] };

  test("cheapest eligible model wins; requirements are hard filters", async () => {
    const onRoute = vi.fn();
    const router = createModelRouter({ id: "router", candidates: [{ provider: big, modelId: "b" }, { provider: mid, modelId: "m" }, { provider: cheapLocal, modelId: "l" }], onRoute });
    expect((await router.generate(req)).content).toBe("local");
    // tools exclude the local model
    expect((await router.generate({ ...req, tools: [{ name: "t", description: "d", parameters: {} }] })).content).toBe("mid");
    // context too large for local
    expect((await router.generate({ ...req, messages: [{ role: "user", content: "x".repeat(2000) }] })).content).toBe("mid");
    expect(onRoute.mock.calls[0]?.[0]).toMatchObject({ chosen: "local/l", reason: "cheapest" });
  });

  test("data classification excludes models not cleared for the data", async () => {
    const router = createModelRouter({ id: "router", candidates: [{ provider: mid, modelId: "m" }, { provider: big, modelId: "b" }], strategy: "best" });
    const r = await router.generate({ ...req, metadata: { dataClassification: "restricted" } });
    expect(r.content).toBe("big"); // mid is not cleared for "restricted"; big has no restriction
  });

  test("fastest strategy, fallback on retryable errors, and no-candidate errors", async () => {
    const flaky = createScriptedProvider([{ error: new LLMError("down", { retryable: true }) }], { id: "flaky", capabilities: { latency: { p50Ms: 10 } } });
    const backup = createScriptedProvider([{ text: "backup" }], { id: "backup", capabilities: { latency: { p50Ms: 500 } } });
    const router = createModelRouter({ id: "r", candidates: [{ provider: backup, modelId: "b" }, { provider: flaky, modelId: "f" }], strategy: "fastest" });
    expect(await router.generate(req)).toMatchObject({ content: "backup", providerMetadata: { routedTo: "backup/b" } });
    const none = createModelRouter({ id: "r", candidates: [{ provider: cheapLocal, modelId: "l" }] });
    await expect(none.generate({ ...req, tools: [{ name: "t", description: "d", parameters: {} }] })).rejects.toThrow(/No model satisfies/);
  });
});

describe("OpenAI-compatible streaming", () => {
  test("parses SSE content and tool-call deltas", async () => {
    const sse = [
      'data: {"id":"c1","choices":[{"delta":{"content":"Hel"}}]}',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"calc","arguments":"{\\"a\\""}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]},"finish_reason":"tool_calls"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}',
      "data: [DONE]",
    ].join("\n\n");
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body))).toMatchObject({ stream: true });
      return new Response(sse);
    });
    const provider = openAICompatibleProvider({ id: "x", baseURL: "https://api.example.com/v1", fetchImpl: fetchImpl as unknown as typeof fetch });
    const events: unknown[] = [];
    for await (const e of provider.stream!({ modelId: "m", messages: [{ role: "user", content: "hi" }] })) events.push(e);
    expect(events.slice(0, 2)).toEqual([{ type: "content_delta", delta: "Hel" }, { type: "content_delta", delta: "lo" }]);
    expect(events[2]).toMatchObject({
      type: "done",
      response: { content: "Hello", finishReason: "tool_calls", toolCalls: [{ id: "t1", name: "calc", arguments: '{"a":1}' }], usage: { inputTokens: 7, outputTokens: 3 } },
    });
  });
});
