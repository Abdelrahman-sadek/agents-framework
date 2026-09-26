import { test, expect, describe, vi } from "vitest";
import { DefaultAgentRuntime } from "./agent-runtime.js";
import { Agent, AgentConfig } from "./agent.js";
import { LLMResponse } from "./llm.js";
import { BaseFrameworkError } from "./errors.js";

function mockProvider(responses: Array<LLMResponse | Promise<LLMResponse> | { throw: () => Error }>) {
  const queue = [...responses];
  return {
    capabilities: vi.fn(async () => ({ streaming: false, toolCalling: false, structuredOutput: false })),
    generate: vi.fn(async () => {
      const next = queue.shift();
      if (next && typeof next === "object" && "throw" in next) {
        throw next.throw();
      }
      return next;
    }),
  };
}

function makeAgent(name: string, modelId: string, overrides: Partial<AgentConfig> = {}): Agent {
  return {
    name,
    agentId: `agent-${name}`,
    config: {
      name,
      model: { providerId: "mock", modelId },
      ...overrides,
    },
    run: async () => { throw new Error("not implemented"); },
    cancel: async () => {},
  };
}

function createRuntime(provider: ReturnType<typeof mockProvider>) {
  const emitted: Array<{ event: any; agentId: string }> = [];
  const emitter = {
    emit: (event: any, agentId: string) => emitted.push({ event, agentId }),
  };
  const runtime = new DefaultAgentRuntime(
    provider,
    emitter,
    { generate: () => `run-${Math.random().toString(36).slice(2, 10)}` },
    { nowISO: () => new Date().toISOString() },
  );
  return { runtime, emitter, emitted };
}

describe("agent runtime", () => {
  test("emits AgentStarted and AgentCompleted on success", async () => {
    const provider = mockProvider([
      {
        id: "llm-1",
        modelId: "gpt-4o",
        content: "Hello!",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5, estimatedCost: 0.001 },
      },
    ]);

    const { runtime, emitted } = createRuntime(provider);
    const agent = makeAgent("hello", "gpt-4o");
    agent.agentId = `agent-hello`;
    const run = runtime.execute(agent, { input: "Hello", metadata: {} });

    const result = await run;
    expect(result.status).toBe("COMPLETED");
    expect(result.output).toBe("Hello!");
    expect(result.runId).toMatch(/^run-/);
    expect(result.events.some((e) => e.type === "AGENT_STARTED")).toBe(true);
    expect(result.events.some((e) => e.type === "LLMCALL_COMPLETED")).toBe(true);

    expect(emitted).toHaveLength(2);
    expect(emitted[0].event.type).toBe("AGENT_STARTED");
    expect(emitted[1].event.type).toBe("LLMCALL_COMPLETED");
  });

  test("emits AgentFailed on provider failure", async () => {
    const provider = mockProvider([{ throw: () => new Error("boom") }]);
    const { runtime, emitted } = createRuntime(provider);
    const agent = makeAgent("failing", "gpt-4o");
    const run = runtime.execute(agent, { input: "hello", metadata: {} });

    await expect(run).resolves.toMatchObject({
      status: "FAILED",
      error: { code: "AGENT_ERROR" },
      events: [{ type: "AGENT_STARTED" }, { type: "AGENT_FAILED" }],
    });

    expect(emitted.some((e) => e.event.type === "AGENT_FAILED")).toBe(true);
  });

  test("propagates structured framework errors", async () => {
    class TestError extends BaseFrameworkError {
      constructor() {
        super("TEST_CODE", "structured failure", { retryable: true });
        this.name = "TestError";
      }
    }
    const provider = mockProvider([{ throw: () => new TestError() }]);
    const { runtime } = createRuntime(provider);
    const agent = makeAgent("structured", "gpt-4o");
    const run = runtime.execute(agent, { input: "hello", metadata: {} });

    await expect(run).resolves.toMatchObject({
      status: "FAILED",
      error: { code: "TEST_CODE" },
    });
  });
});
