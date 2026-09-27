import { describe, expect, test } from "vitest";
import {
  CancellationError,
  ConfigurationError,
  ExecutionError,
  FrameworkError,
  LimitExceededError,
  LLMError,
  RateLimitError,
  ToolAuthorizationError,
  isRetryable,
} from "./errors.js";

describe("error model", () => {
  test("carries code, category, retryability and correlation ids", () => {
    const err = new LLMError("provider down", { retryable: true, runId: "r1", llmCallId: "l1", metadata: { status: 503 } });
    expect(err).toBeInstanceOf(FrameworkError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("LLMError");
    expect(err.toJSON()).toEqual({
      code: "LLM_ERROR",
      message: "provider down",
      category: "provider",
      retryable: true,
      metadata: { status: 503 },
      runId: "r1",
      llmCallId: "l1",
    });
  });

  test("keeps the cause without serializing it", () => {
    const cause = new Error("socket hang up");
    const err = new ExecutionError("failed", { cause });
    expect(err.cause).toBe(cause);
    expect(JSON.stringify(err.toJSON())).not.toContain("socket");
  });

  test("security and developer errors are never retryable", () => {
    expect(new ToolAuthorizationError("no", { retryable: true }).retryable).toBe(false);
    expect(new ConfigurationError("bad", { retryable: true }).retryable).toBe(false);
    expect(new CancellationError().retryable).toBe(false);
  });

  test("rate limits are retryable by default", () => {
    expect(isRetryable(new RateLimitError("slow down"))).toBe(true);
    expect(isRetryable(new Error("plain"))).toBe(false);
  });

  test("LimitExceededError records the limit", () => {
    const err = new LimitExceededError("tokens", 100, 150);
    expect(err.code).toBe("LIMIT_EXCEEDED");
    expect(err.metadata).toMatchObject({ limitType: "tokens", limit: 100, current: 150 });
  });

  test("from() normalizes unknown values", () => {
    const existing = new LLMError("x");
    expect(FrameworkError.from(existing)).toBe(existing);
    const wrapped = FrameworkError.from("boom");
    expect(wrapped).toBeInstanceOf(ExecutionError);
    expect(wrapped.message).toBe("boom");
    const custom = FrameworkError.from(new Error("y"), (m, cause) => new LLMError(m, { cause }));
    expect(custom.code).toBe("LLM_ERROR");
  });
});
