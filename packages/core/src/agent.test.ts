import { describe, expect, test } from "vitest";
import { defineAgent } from "./agent.js";
import { ConfigurationError } from "./errors.js";
import { resolveLimits } from "./limits.js";
import { DEFAULT_RUN_LIMITS } from "./types.js";

const model = { providerId: "scripted", modelId: "m" };
const tool = (name: string) => ({ name, description: "d", parameters: { type: "object" } });

describe("defineAgent", () => {
  test("returns a frozen agent with defaults", () => {
    const agent = defineAgent({ name: "assistant", model });
    expect(agent.id).toBe("assistant");
    expect(agent.config.tools).toEqual([]);
    expect(Object.isFrozen(agent)).toBe(true);
    expect(Object.isFrozen(agent.config)).toBe(true);
  });

  test.each(["", "has space", "x".repeat(65), "-leading"])("rejects invalid name %j", (name) => {
    expect(() => defineAgent({ name, model })).toThrow(ConfigurationError);
  });

  test("rejects a missing model", () => {
    expect(() => defineAgent({ name: "a", model: undefined as never })).toThrow(/model/);
  });

  test("rejects duplicate and invalid tool names", () => {
    expect(() => defineAgent({ name: "a", model, tools: [tool("x"), tool("x")] })).toThrow(/duplicate/);
    expect(() => defineAgent({ name: "a", model, tools: [tool("bad name")] })).toThrow(/invalid tool name/);
  });

  test("rejects invalid limits", () => {
    expect(() => defineAgent({ name: "a", model, limits: { maxSteps: 0 } })).toThrow(/maxSteps/);
    expect(() => defineAgent({ name: "a", model, limits: { maxCost: -1 } })).toThrow(/maxCost/);
  });

  test("run() without a runtime fails with guidance", () => {
    const agent = defineAgent({ name: "a", model });
    expect(() => agent.run({ input: "hi" })).toThrow(/not bound to a runtime/);
  });
});

describe("limits", () => {
  test("later layers override earlier ones", () => {
    const limits = resolveLimits({ maxSteps: 5 }, undefined, { maxSteps: 3, maxCost: 1 });
    expect(limits).toEqual({ ...DEFAULT_RUN_LIMITS, maxSteps: 3, maxCost: 1 });
  });
});
