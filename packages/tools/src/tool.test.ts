import { test, expect, describe } from "vitest";
import { defineTool, ToolRuntime, validateInput, isRetryable, DefaultPolicyEngine } from "./index.js";
import { ToolAuthorizationError, ToolError, ApprovalRequiredError } from "@agent-framework/core";
import { z } from "zod";

describe("defineTool", () => {
  test("creates a tool with schema and execute handler", () => {
    const tool = defineTool({
      name: "search",
      description: "Search the knowledge source",
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({ results: z.array(z.string()) }),
      execute: async (_input, _context) => ({ results: ["a", "b"] }),
    });

    expect(tool.name).toBe("search");
    expect(tool.inputSchema).toBeDefined();
    expect(tool.execute).toBeTypeOf("function");
  });

  test("tool can declare permissions", () => {
    const tool = defineTool({
      name: "restricted",
      description: "A restricted tool",
      inputSchema: z.object({ value: z.string() }),
      execute: async (_input, _context) => ({ ok: true }),
      permissions: { allowed: ["restricted"] },
    });

    expect(tool.permissions?.allowed).toEqual(["restricted"]);
  });
});

describe("validateInput", () => {
  const tool = defineTool({
    name: "add",
    description: "Add two numbers",
    inputSchema: z.object({ a: z.number(), b: z.number() }),
    execute: async (input) => ({ sum: input.a + input.b }),
  });

  test("accepts valid input", () => {
    const result = validateInput(tool, { a: 1, b: 2 });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ a: 1, b: 2 });
  });

  test("rejects malformed input", () => {
    const result = validateInput(tool, { a: "not-a-number", b: 2 });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("isRetryable", () => {
  test("classifies retryable codes", () => {
    expect(isRetryable("LLM_ERROR")).toBe(true);
    expect(isRetryable("INFRASTRUCTURE_ERROR")).toBe(true);
    expect(isRetryable("TOOL_ERROR")).toBe(true);
    expect(isRetryable("VALIDATION_ERROR")).toBe(true);
  });

  test("classifies non-retryable codes", () => {
    expect(isRetryable("TOOL_AUTHORIZATION_ERROR")).toBe(false);
    expect(isRetryable("APPROVAL_REQUIRED_ERROR")).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
  });
});

describe("ToolRuntime authorization", () => {
  test("allows tool when permission allows it", async () => {
    const runtime = new ToolRuntime();
    const tool = defineTool({
      name: "allowed-tool",
      description: "Allowed",
      inputSchema: z.object({ x: z.string() }),
      execute: async (input) => ({ echoed: input.x }),
      permissions: { allowed: ["allowed-tool"], dataScope: ["read"] },
    });

    const result = await runtime.execute({
      tool,
      input: { x: "hello" },
      callId: crypto.randomUUID(),
      runId: "run-1",
      agentId: "agent-1",
    });

    expect(result.ok).toBe(true);
    expect(result.output?.echoed).toBe("hello");
  });

  test("denies tool when permission denies it", async () => {
    const runtime = new ToolRuntime();
    const tool = defineTool({
      name: "denied-tool",
      description: "Denied",
      inputSchema: z.object({ x: z.string() }),
      execute: async (input) => ({ echoed: input.x }),
      permissions: { denied: ["denied-tool"] },
    });

    const result = await runtime.execute({
      tool,
      input: { x: "hello" },
      callId: crypto.randomUUID(),
      runId: "run-1",
      agentId: "agent-1",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("TOOL_AUTHORIZATION_ERROR");
  });

  test("denies tool when not in allowed list", async () => {
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

describe("ToolRuntime input validation enforcement", () => {
  test("does not execute when input is invalid", async () => {
    let executed = false;
    const runtime = new ToolRuntime();
    const tool = defineTool({
      name: "strict",
      description: "Strict input",
      inputSchema: z.object({ query: z.string() }),
      execute: async (_input, _context) => {
        executed = true;
        return { result: "done" };
      },
    });

    const result = await runtime.execute({
      tool,
      input: { query: 123 },
      callId: crypto.randomUUID(),
      runId: "run-1",
      agentId: "agent-1",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("VALIDATION_ERROR");
    expect(executed).toBe(false);
  });
});

describe("ToolRuntime timeout", () => {
  test("enforces tool timeout", async () => {
    const runtime = new ToolRuntime();
    const tool = defineTool({
      name: "slow",
      description: "Slow tool",
      inputSchema: z.object({ delay: z.number() }),
      execute: async (input, context) => {
        await new Promise<void>((resolve, reject) => {
          const id = setTimeout(() => resolve(), input.delay);
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
      input: { delay: 500 },
      callId: crypto.randomUUID(),
      runId: "run-1",
      agentId: "agent-1",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("TOOL_CALL_TIMED_OUT");
  });

  test("supports cancellation via AbortSignal", async () => {
    const runtime = new ToolRuntime();
    const controller = new AbortController();
    const tool = defineTool({
      name: "cancelable",
      description: "Cancelable tool",
      inputSchema: z.object({ delay: z.number() }),
      execute: async (input, context) => {
        await new Promise<void>((resolve, reject) => {
          const id = setTimeout(() => resolve(), input.delay);
          context.signal?.addEventListener("abort", () => {
            clearTimeout(id);
            reject(new Error("Aborted"));
          }, { once: true });
        });
        return { ok: true };
      },
      timeoutMs: 5000,
    });

    const resultPromise = runtime.execute({
      tool,
      input: { delay: 5000 },
      callId: crypto.randomUUID(),
      runId: "run-1",
      agentId: "agent-1",
      signal: controller.signal,
    });

    await sleep(50);
    controller.abort();

    const result = await resultPromise;
    expect(result.ok).toBe(false);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ToolRuntime retry classification", () => {
  test("retryable errors are retried according to config", async () => {
    let attempts = 0;
    const runtime = new ToolRuntime();
    const tool = defineTool({
      name: "flaky",
      description: "Flaky tool",
      inputSchema: z.object({ value: z.string() }),
      execute: async (input) => {
        attempts++;
        if (attempts < 3) {
          throw new ToolError("temporary failure", { retryable: true });
        }
        return { value: input.value };
      },
      retry: { maxAttempts: 3 },
    });

    const result = await runtime.execute({
      tool,
      input: { value: "x" },
      callId: crypto.randomUUID(),
      runId: "run-1",
      agentId: "agent-1",
    });

    expect(result.ok).toBe(true);
    expect(result.output?.value).toBe("x");
    expect(attempts).toBe(3);
  });
});

describe("ToolRuntime idempotency", () => {
  test("returns cached result for idempotent calls", async () => {
    const runtime = new ToolRuntime();
    const tool = defineTool({
      name: "idempotent",
      description: "Idempotent",
      inputSchema: z.object({ id: z.string() }),
      execute: async (input) => ({ stored: input.id }),
      idempotency: { enabled: true, key: "idempotency-key" },
    });

    const callId = crypto.randomUUID();
    const first = await runtime.execute({
      tool,
      input: { id: "a" },
      callId,
      runId: "run-1",
      agentId: "agent-1",
    });

    const second = await runtime.execute({
      tool,
      input: { id: "a" },
      callId,
      runId: "run-1",
      agentId: "agent-1",
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.output).toEqual(first.output);
  });
});

describe("ToolRuntime observation and audit", () => {
  test("emits observation and records audit entry", async () => {
    const runtime = new ToolRuntime();
    const tool = defineTool({
      name: "observed",
      description: "Observed",
      inputSchema: z.object({ q: z.string() }),
      execute: async (input) => ({ ok: input.q }),
    });

    await runtime.execute({
      tool,
      input: { q: "query" },
      callId: crypto.randomUUID(),
      runId: "run-1",
      agentId: "agent-1",
    });

    const observations = runtime.observationEmitter.getObservations();
    expect(observations.some((o) => o.toolName === "observed")).toBe(true);

    const auditEntries = runtime.auditStore.getEntries();
    expect(auditEntries.some((a) => a.toolName === "observed")).toBe(true);
  });
});
