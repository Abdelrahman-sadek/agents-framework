import { test, expect, describe } from "vitest";
import { BaseFrameworkError, AgentError, ValidationError, LLMError, ExecutionError, ApprovalRequiredError } from "./errors.js";
import { toEnvelope, type AgentEvent } from "./events.js";
import { LLMRequest } from "./llm.js";
import { RunLimits } from "./types.js";

describe("errors", () => {
  test("BaseFrameworkError carries code and retryable flag", () => {
    const err = new BaseFrameworkError("CODE", "message", { retryable: true });
    expect(err.code).toBe("CODE");
    expect(err.message).toBe("message");
    expect(err.retryable).toBe(true);
  });

  test("AgentError is not retryable by default", () => {
    const err = new AgentError("bad agent");
    expect(err.retryable).toBe(false);
    expect(err.code).toBe("AGENT_ERROR");
  });

  test("ValidationError is retryable by default", () => {
    const err = new ValidationError("bad input");
    expect(err.retryable).toBe(true);
    expect(err.code).toBe("VALIDATION_ERROR");
  });

  test("LLMError supports provider metadata", () => {
    const err = new LLMError("provider down", { retryable: true, metadata: { provider: "openai" } });
    expect(err.retryable).toBe(true);
    expect(err.code).toBe("LLM_ERROR");
    expect(err.metadata).toEqual({ provider: "openai" });
  });

  test("ApprovalRequiredError is not retryable", () => {
    const err = new ApprovalRequiredError("approval needed");
    expect(err.retryable).toBe(false);
    expect(err.code).toBe("APPROVAL_REQUIRED_ERROR");
  });
});

describe("events", () => {
  test("toEnvelope attaches runId and agentId", () => {
    const event: AgentEvent = {
      type: "AGENT_STARTED",
      payload: { runId: "run-1", agentId: "agent-1", name: "test", input: "hi" },
    };
    const envelope = toEnvelope(event, "agent-1");
    expect(envelope.runId).toBe("run-1");
    expect(envelope.agentId).toBe("agent-1");
    expect(envelope.type).toBe("AGENT_STARTED");
    expect(envelope.eventId).toBeDefined();
    expect(envelope.occurredAt).toBeDefined();
  });

  test("event types remain distinct", () => {
    const started: AgentEvent = { type: "AGENT_STARTED", payload: { runId: "r", agentId: "a", name: "n", input: "" } };
    const completed: AgentEvent = { type: "AGENT_COMPLETED", payload: { runId: "r", agentId: "a", status: "COMPLETED", output: {} } };
    const toolStarted: AgentEvent = { type: "TOOLCALL_STARTED", payload: { toolCallId: "t", runId: "r", agentId: "a", toolName: "tool", input: {} } };
    const toolCompleted: AgentEvent = { type: "TOOLCALL_COMPLETED", payload: { toolCallId: "t", runId: "r", agentId: "a", toolName: "tool", output: "ok" } };
    const toolFailed: AgentEvent = { type: "TOOLCALL_FAILED", payload: { toolCallId: "t", runId: "r", agentId: "a", toolName: "tool", error: { code: "E", message: "m" } } };

    expect(started.type).toBe("AGENT_STARTED");
    expect(completed.type).toBe("AGENT_COMPLETED");
    expect(toolStarted.type).toBe("TOOLCALL_STARTED");
    expect(toolCompleted.type).toBe("TOOLCALL_COMPLETED");
    expect(toolFailed.type).toBe("TOOLCALL_FAILED");
  });
});

describe("llm types", () => {
  test("LLMRequest can carry messages and settings", () => {
    const request: LLMRequest = {
      modelId: "model",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hello" },
      ],
      settings: { maxTokens: 100, temperature: 0.2 },
    };
    expect(request.modelId).toBe("model");
    expect(request.messages).toHaveLength(2);
    expect(request.settings?.maxTokens).toBe(100);
  });
});

describe("run limits", () => {
  test("RunLimits allows partial overrides", () => {
    const limits: RunLimits = {
      maxSteps: 5,
      maxTokens: 2000,
      timeout: 5000,
    };
    expect(limits.maxSteps).toBe(5);
    expect(limits.maxTokens).toBe(2000);
    expect(limits.maxRetries).toBeUndefined();
  });
});
