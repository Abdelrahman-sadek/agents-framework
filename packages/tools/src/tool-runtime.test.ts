import { test, expect, describe } from "vitest";
import { defineTool, ToolRuntime } from "./index.js";
import { DefaultAgentRuntime, type Agent, type AgentRunResult, type LLMProvider, type LLMResponse } from "@agent-framework/core";
import { ToolAuthorizationError, ApprovalRequiredError } from "@agent-framework/core";
import { z } from "zod";

function mockLLMWithToolCalls(toolCallResults: Array<{ toolName: string; result: any } | null>) {
  const queue = [...toolCallResults];
  const provider: LLMProvider = {
    capabilities: async () => ({ streaming: false, toolCalling: true, structuredOutput: true }),
    generate: async () => {
      const next = queue.shift() ?? null;
      if (!next) {
        return {
          id: crypto.randomUUID(),
          modelId: "mock",
          content: "I used a tool.",
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 5, outputTokens: 5, estimatedCost: 0 },
        };
      }
      return {
        id: crypto.randomUUID(),
        modelId: "mock",
        content: "",
        toolCalls: [{ id: crypto.randomUUID(), name: next.toolName, arguments: "{}" }],
        finishReason: "tool_calls",
        usage: { inputTokens: 5, outputTokens: 2, estimatedCost: 0 },
      };
    },
  };
  return provider;
}

describe("agent -> tool integration", () => {
  test("agent and tool runtime work together for a successful tool execution", async () => {
    const searchTool = defineTool({
      name: "search",
      description: "Search the knowledge source",
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({ results: z.array(z.string()) }),
      execute: async (input) => ({ results: [`result-for-${input.query}`] }),
    });

    const runtime = new ToolRuntime();
    const provider = mockLLMWithToolCalls([{ toolName: "search", result: { results: ["result-for-hello"] } }]);
    const agentRuntime = new DefaultAgentRuntime(
      provider,
      { emit: () => {} },
      { generate: () => `run-${crypto.randomUUID().slice(0, 8)}` },
      { nowISO: () => new Date().toISOString() },
    );

    const agent: Agent = {
      name: "research-agent",
      agentId: "research-agent",
      config: {
        name: "research-agent",
        model: { providerId: "mock", modelId: "mock" },
        system: "You are a helpful assistant.",
        tools: [searchTool],
      },
      run: async (runConfig) => agentRuntime.execute(agent, runConfig),
      cancel: async () => {},
    };

    const result = await agent.run({ input: "Search hello", metadata: {} });

    expect(result.status).toBe("COMPLETED");
    expect(result.events.some((e) => e.type === "AGENT_STARTED")).toBe(true);
    expect(result.events.some((e) => e.type === "LLMCALL_COMPLETED")).toBe(true);
  });
});

describe("tool failure propagation", () => {
  test("tool failure is reflected in tool runtime result", async () => {
    const runtime = new ToolRuntime();
    const failingTool = defineTool({
      name: "fails",
      description: "Fails",
      inputSchema: z.object({ x: z.string() }),
      execute: async () => {
        throw new Error("boom");
      },
    });

    const result = await runtime.execute({
      tool: failingTool,
      input: { x: "a" },
      callId: crypto.randomUUID(),
      runId: "run-1",
      agentId: "agent-1",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("TOOL_ERROR");
  });
});

describe("multiple tools", () => {
  test("runtime can execute multiple different tools", async () => {
    const runtime = new ToolRuntime();
    const first = defineTool({
      name: "first",
      description: "First",
      inputSchema: z.object({ v: z.string() }),
      execute: async (input) => ({ name: input.v }),
    });
    const second = defineTool({
      name: "second",
      description: "Second",
      inputSchema: z.object({ v: z.string() }),
      execute: async (input) => ({ name: input.v.toUpperCase() }),
    });

    const a = await runtime.execute({ tool: first, input: { v: "a" }, callId: crypto.randomUUID(), runId: "run-1", agentId: "agent-1" });
    const b = await runtime.execute({ tool: second, input: { v: "b" }, callId: crypto.randomUUID(), runId: "run-1", agentId: "agent-1" });

    expect(a.ok).toBe(true);
    expect(a.output?.name).toBe("a");
    expect(b.ok).toBe(true);
    expect(b.output?.name).toBe("B");
  });
});

describe("invalid tool arguments", () => {
  test("malformed tool arguments cannot execute", async () => {
    const runtime = new ToolRuntime();
    const tool = defineTool({
      name: "strict",
      description: "Strict",
      inputSchema: z.object({ id: z.string().uuid() }),
      execute: async () => ({ ok: true }),
    });

    const result = await runtime.execute({
      tool,
      input: { id: "not-a-uuid" },
      callId: crypto.randomUUID(),
      runId: "run-1",
      agentId: "agent-1",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("VALIDATION_ERROR");
  });
});

describe("authorization denial", () => {
  test("unauthorized tool cannot execute", async () => {
    const runtime = new ToolRuntime();
    const tool = defineTool({
      name: "protected",
      description: "Protected",
      inputSchema: z.object({ x: z.string() }),
      execute: async () => ({ ok: true }),
      permissions: { denied: ["protected"] },
    });

    const result = await runtime.execute({
      tool,
      input: { x: "a" },
      callId: crypto.randomUUID(),
      runId: "run-1",
      agentId: "agent-1",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("TOOL_AUTHORIZATION_ERROR");
  });
});

describe("timeout enforcement", () => {
  test("tool timeout is enforced", async () => {
    const runtime = new ToolRuntime();
    const tool = defineTool({
      name: "slow",
      description: "Slow",
      inputSchema: z.object({ ms: z.number() }),
      execute: async (input, context) => {
        await new Promise<void>((resolve, reject) => {
          const id = setTimeout(() => resolve(), input.ms);
          context.signal?.addEventListener("abort", () => {
            clearTimeout(id);
            reject(new Error("Aborted"));
          }, { once: true });
        });
        return { ok: true };
      },
      timeoutMs: 50,
    });

    const result = await runtime.execute({
      tool,
      input: { ms: 500 },
      callId: crypto.randomUUID(),
      runId: "run-1",
      agentId: "agent-1",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("TOOL_CALL_TIMED_OUT");
  });
});

describe("retryable vs non-retryable failure", () => {
  test("retryable failure is retried", async () => {
    let attempts = 0;
    const runtime = new ToolRuntime();
    const tool = defineTool({
      name: "retryable",
      description: "Retryable",
      inputSchema: z.object({ x: z.string() }),
      execute: async () => {
        attempts++;
        if (attempts < 3) throw new Error("temp");
        return { ok: true };
      },
      retry: { maxAttempts: 3 },
    });

    const result = await runtime.execute({
      tool,
      input: { x: "a" },
      callId: crypto.randomUUID(),
      runId: "run-1",
      agentId: "agent-1",
    });

    expect(result.ok).toBe(true);
    expect(attempts).toBe(3);
  });

  test("non-retryable failure is not retried", async () => {
    let attempts = 0;
    const runtime = new ToolRuntime();
    const tool = defineTool({
      name: "nonretryable",
      description: "Non-retryable",
      inputSchema: z.object({ x: z.string() }),
      execute: async () => {
        attempts++;
        throw new ToolAuthorizationError("denied");
      },
      retry: { maxAttempts: 3 },
    });

    const result = await runtime.execute({
      tool,
      input: { x: "a" },
      callId: crypto.randomUUID(),
      runId: "run-1",
      agentId: "agent-1",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("TOOL_AUTHORIZATION_ERROR");
    expect(attempts).toBe(1);
  });
});

describe("mock approval flow", () => {
  test("approval-required tool returns approval error", async () => {
    const runtime = new ToolRuntime();
    const policyEngine = {
      authorize: async () => ({ allowed: true, requiredApproval: true, approvalId: "approval-1" }),
    } as any;
    const tool = defineTool({
      name: "approved-only",
      description: "Approved only",
      inputSchema: z.object({ x: z.string() }),
      execute: async () => ({ ok: true }),
      approval: { required: true },
    });

    const runtimeWithMock = new ToolRuntime(policyEngine);
    const result = await runtimeWithMock.execute({
      tool,
      input: { x: "a" },
      callId: crypto.randomUUID(),
      runId: "run-1",
      agentId: "agent-1",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("APPROVAL_REQUIRED_ERROR");
  });
});
