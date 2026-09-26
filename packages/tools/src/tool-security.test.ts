import { test, expect, describe } from "vitest";
import { defineTool, ToolRuntime, validateInput, DefaultPolicyEngine } from "./index.js";
import { ToolAuthorizationError, ApprovalRequiredError } from "@agent-framework/core";
import { z } from "zod";

describe("security: LLM cannot bypass authorization", () => {
  test("tool authorization is enforced regardless of tool input content", async () => {
    const runtime = new ToolRuntime();
    const tool = defineTool({
      name: "protected",
      description: "Protected",
      inputSchema: z.object({ action: z.string() }),
      execute: async () => ({ executed: true }),
      permissions: { denied: ["protected"] },
    });

    const result = await runtime.execute({
      tool,
      input: { action: "delete-everything" },
      callId: crypto.randomUUID(),
      runId: "run-1",
      agentId: "agent-1",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("TOOL_AUTHORIZATION_ERROR");
  });
});

describe("security: unauthorized tool cannot execute", () => {
  test("tool not in allowed list cannot execute", async () => {
    const runtime = new ToolRuntime();
    const tool = defineTool({
      name: "admin-tool",
      description: "Admin tool",
      inputSchema: z.object({ x: z.string() }),
      execute: async () => ({ ok: true }),
      permissions: { allowed: ["different-tool"] },
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

describe("security: malformed tool arguments cannot execute", () => {
  test("invalid tool input is rejected before execution", async () => {
    let executed = false;
    const runtime = new ToolRuntime();
    const tool = defineTool({
      name: "strict",
      description: "Strict",
      inputSchema: z.object({ token: z.string().min(8) }),
      execute: async () => {
        executed = true;
        return { ok: true };
      },
    });

    const result = await runtime.execute({
      tool,
      input: { token: "short" },
      callId: crypto.randomUUID(),
      runId: "run-1",
      agentId: "agent-1",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("VALIDATION_ERROR");
    expect(executed).toBe(false);
  });
});

describe("security: tool timeout is enforced", () => {
  test("configured tool timeout stops long-running tool execution", async () => {
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
      timeoutMs: 30,
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

describe("security: tool cannot exceed configured limits", () => {
  test("tool retry limit prevents unbounded retries", async () => {
    let attempts = 0;
    const runtime = new ToolRuntime();
    const tool = defineTool({
      name: "flaky",
      description: "Flaky",
      inputSchema: z.object({ x: z.string() }),
      execute: async () => {
        attempts++;
        throw new Error("nope");
      },
      retry: { maxAttempts: 2 },
    });

    const result = await runtime.execute({
      tool,
      input: { x: "a" },
      callId: crypto.randomUUID(),
      runId: "run-1",
      agentId: "agent-1",
    });

    expect(result.ok).toBe(false);
    expect(attempts).toBeLessThanOrEqual(2);
  });
});

describe("security: sensitive tool metadata is not accidentally exposed", () => {
  test("observation includes duration metadata but not secret internal fields", async () => {
    const runtime = new ToolRuntime();
    const tool = defineTool({
      name: "safe",
      description: "Safe",
      inputSchema: z.object({ q: z.string() }),
      execute: async (input) => ({ result: input.q }),
      metadata: { internal: "secret", safe: "public" },
    });

    await runtime.execute({
      tool,
      input: { q: "query" },
      callId: crypto.randomUUID(),
      runId: "run-1",
      agentId: "agent-1",
    });

    const observations = runtime.observationEmitter.getObservations();
    const observation = observations.find((o) => o.toolName === "safe");
    expect(observation).toBeDefined();
    expect(observation?.metadata).toBeDefined();
    expect(observation?.metadata).not.toHaveProperty("internal");
  });
});

describe("security: policy engine is deterministic", () => {
  test("default policy engine denies denied tools", async () => {
    const policy = new DefaultPolicyEngine();
    const result = await policy.authorize({
      toolName: "denied-tool",
      toolVersion: "1",
      input: {},
      runId: "run-1",
      agentId: "agent-1",
      toolCallId: crypto.randomUUID(),
      metadata: { permissions: { denied: ["denied-tool"] } },
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBeDefined();
  });

  test("default policy engine denies tools not in allowed list", async () => {
    const policy = new DefaultPolicyEngine();
    const result = await policy.authorize({
      toolName: "admin-tool",
      toolVersion: "1",
      input: {},
      runId: "run-1",
      agentId: "agent-1",
      toolCallId: crypto.randomUUID(),
      metadata: { permissions: { allowed: ["different-tool"] } },
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBeDefined();
  });
});
