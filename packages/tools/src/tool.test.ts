import { ConfigurationError } from "@agent-framework/core";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { defineTool, isTool } from "./tool.js";

const base = {
  name: "search",
  description: "Search documents",
  input: z.object({ query: z.string().describe("Search terms"), limit: z.number().int().max(20).default(5) }),
  execute: async () => ({ hits: [] as string[] }),
};

describe("defineTool", () => {
  test("produces a branded, frozen tool with a JSON Schema for the model", () => {
    const tool = defineTool(base);
    expect(isTool(tool)).toBe(true);
    expect(Object.isFrozen(tool)).toBe(true);
    expect(tool.kind).toBe("native");
    expect(tool.parameters).toMatchObject({
      type: "object",
      properties: { query: { type: "string", description: "Search terms" }, limit: { type: "integer" } },
      required: ["query"],
    });
    expect(tool.parameters).not.toHaveProperty("$schema");
  });

  test("infers input types for execute", () => {
    defineTool({
      ...base,
      execute: async (input) => {
        const q: string = input.query;
        const n: number = input.limit;
        return { hits: [q.repeat(n)] };
      },
    });
  });

  test.each([
    [{ name: "bad name" }, /name/],
    [{ name: "x".repeat(65) }, /name/],
    [{ description: "  " }, /description/],
    [{ input: { safeParse: () => ({ success: true }) } }, /Zod schema/],
    [{ timeoutMs: 0 }, /timeoutMs/],
    [{ retry: { maxAttempts: 0 } }, /maxAttempts/],
    [{ concurrency: 1.5 }, /concurrency/],
  ])("rejects invalid config %j", (override, message) => {
    expect(() => defineTool({ ...base, ...(override as object) } as never)).toThrow(ConfigurationError);
    expect(() => defineTool({ ...base, ...(override as object) } as never)).toThrow(message);
  });

  test("plain objects are not tools", () => {
    expect(isTool({ name: "x", description: "y", parameters: {} })).toBe(false);
    expect(isTool(null)).toBe(false);
  });
});
