import { LLMError, ValidationError, createRuntime, defineAgent } from "@agent-farmework/core";
import { createScriptedProvider } from "@agent-farmework/core/testing";
import { describe, expect, test, vi } from "vitest";
import { withCircuitBreaker, withFallback, withRateLimit } from "./gateway.js";
import { openAICompatibleProvider } from "./openai-compatible.js";

const req = { modelId: "m", messages: [{ role: "user" as const, content: "hi" }] };

describe("OpenAI-compatible adapter", () => {
  test("maps tools, tool calls, structured output and usage", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      const reply =
        bodies.length === 1
          ? { choices: [{ message: { content: null, tool_calls: [{ id: "c1", function: { name: "calc", arguments: '{"a":1}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } } }
          : { choices: [{ message: { content: "2" }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 1 } };
      return new Response(JSON.stringify(reply));
    });
    const provider = openAICompatibleProvider({ id: "ollama", baseURL: "http://localhost:11434/v1", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(provider.capabilities("llama3")).toMatchObject({ deployment: "local" });
    const runtime = createRuntime({ providers: [provider], tools: { invoke: async () => ({ status: "success", output: 2, attempts: 1, durationMs: 0, cached: false }) } });
    const agent = defineAgent({ name: "a", model: { providerId: "ollama", modelId: "llama3" }, tools: [{ name: "calc", description: "d", parameters: { type: "object" } }], runtime });
    const result = await agent.run({ input: "1+1" });
    expect(result).toMatchObject({ status: "COMPLETED", output: "2", usage: { inputTokens: 32, cachedInputTokens: 4 } });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://localhost:11434/v1/chat/completions");
    expect(bodies[0]).toMatchObject({ model: "llama3", tools: [{ type: "function", function: { name: "calc" } }] });
    expect(bodies[1]?.["messages"]).toEqual(expect.arrayContaining([{ role: "tool", tool_call_id: "c1", content: "2" }]));
  });

  test("HTTP errors are normalized by retryability", async () => {
    const make = (status: number) => openAICompatibleProvider({ id: "x", baseURL: "https://api.example.com/v1", apiKey: "k", fetchImpl: (async () => new Response("err", { status })) as unknown as typeof fetch });
    await expect(make(429).generate(req)).rejects.toMatchObject({ code: "RATE_LIMITED", retryable: true });
    await expect(make(503).generate(req)).rejects.toMatchObject({ code: "LLM_ERROR", retryable: true });
    await expect(make(400).generate(req)).rejects.toMatchObject({ retryable: false });
  });
});

describe("gateway wrappers", () => {
  test("circuit breaker opens after repeated failures and closes after a successful trial", async () => {
    let t = 0;
    let fail = true;
    const inner = { id: "p", capabilities: () => ({}) as never, generate: vi.fn(async () => { if (fail) throw new LLMError("down", { retryable: true }); return { id: "r", modelId: "m", content: "ok", toolCalls: [], finishReason: "stop" as const, usage: { inputTokens: 1, outputTokens: 1 } }; }) };
    const breaker = withCircuitBreaker(inner, { failureThreshold: 2, resetAfterMs: 100, now: () => t });
    await expect(breaker.generate(req)).rejects.toThrow("down");
    await expect(breaker.generate(req)).rejects.toThrow("down");
    expect(breaker.circuit).toBe("open");
    await expect(breaker.generate(req)).rejects.toThrow(/Circuit open/);
    expect(inner.generate).toHaveBeenCalledTimes(2);
    t = 150;
    fail = false;
    expect(breaker.circuit).toBe("half-open");
    await expect(breaker.generate(req)).resolves.toMatchObject({ content: "ok" });
    expect(breaker.circuit).toBe("closed");
  });

  test("fallback serves retryable failures, but never masks non-retryable ones", async () => {
    const primary = createScriptedProvider([{ error: new LLMError("overloaded", { retryable: true }) }, { error: new ValidationError("bad request") }], { id: "primary" });
    const backup = createScriptedProvider([{ text: "from backup" }], { id: "backup" });
    const onFallback = vi.fn();
    const provider = withFallback(primary, [{ provider: backup, modelId: "small" }], { onFallback });
    const response = await provider.generate(req);
    expect(response).toMatchObject({ content: "from backup", providerMetadata: { servedBy: "backup/small" } });
    expect(backup.requests[0]?.modelId).toBe("small");
    expect(onFallback).toHaveBeenCalledOnce();
    await expect(provider.generate(req)).rejects.toThrow("bad request");
  });

  test("rate limit spaces requests", async () => {
    const inner = createScriptedProvider([{ text: "a" }, { text: "b" }]);
    const limited = withRateLimit(inner, { requestsPerMinute: 1200 }); // 50 ms apart
    const started = Date.now();
    await Promise.all([limited.generate(req), limited.generate(req)]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });
});
