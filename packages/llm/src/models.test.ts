import { describe, expect, test } from "vitest";
import { models, withFallbacks } from "./index.js";

describe("models", () => {
  test("creates serializable, vendor-free selectors", () => {
    expect(models.openai("gpt-x")).toEqual({ providerId: "openai", modelId: "gpt-x" });
    expect(models.local("ollama", "llama3")).toEqual({ providerId: "ollama", modelId: "llama3", capabilities: { deployment: "local" } });
    expect(JSON.parse(JSON.stringify(models.anthropic("m")))).toEqual(models.anthropic("m"));
  });

  test("rejects empty ids", () => {
    expect(() => models.custom("", "m")).toThrow(TypeError);
  });

  test("withFallbacks attaches ordered fallbacks", () => {
    const s = withFallbacks(models.openai("a"), models.anthropic("b"));
    expect(s.fallbacks?.map((f) => f.providerId)).toEqual(["anthropic"]);
  });
});
