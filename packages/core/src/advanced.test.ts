import { describe, expect, test } from "vitest";
import { defineAgent } from "./agent.js";
import { ConfigurationError } from "./errors.js";
import { ruleVerifier } from "./reflection.js";
import { createRuntime } from "./runtime.js";
import { defineSkill } from "./skill.js";
import { createScriptedProvider } from "./testing.js";

const model = { providerId: "scripted", modelId: "m" };

describe("streaming", () => {
  test("agent.stream yields text deltas, live events and the result", async () => {
    const provider = createScriptedProvider([{ text: "Hello streaming world" }], { streaming: true });
    const agent = defineAgent({ name: "s", model, runtime: createRuntime({ providers: [provider] }) });
    const text: string[] = [];
    const events: string[] = [];
    let status = "";
    for await (const chunk of agent.stream({ input: "hi" })) {
      if (chunk.type === "text") text.push(chunk.delta);
      else if (chunk.type === "event") events.push(chunk.event.type);
      else status = chunk.result.status;
    }
    expect(text.join("")).toBe("Hello streaming world");
    expect(text.length).toBe(3);
    expect(events[0]).toBe("AGENT_STARTED");
    expect(events.at(-1)).toBe("AGENT_COMPLETED");
    expect(status).toBe("COMPLETED");
  });

  test("falls back to generate when the provider cannot stream", async () => {
    const deltas: string[] = [];
    const agent = defineAgent({ name: "s", model, runtime: createRuntime({ providers: [createScriptedProvider([{ text: "plain" }])] }) });
    const result = await agent.run({ input: "hi", onTextDelta: (d) => deltas.push(d) });
    expect(result.output).toBe("plain");
    expect(deltas).toEqual([]);
  });
});

describe("skills", () => {
  const lookup = { name: "lookup", description: "d", parameters: {} };
  const citing = defineSkill({ name: "citing", description: "Cite sources", instructions: "Always cite [n].", verifiers: [ruleVerifier("cites", ({ text }) => (/\[\d\]/.test(text) ? true : "cite"))] });
  const research = defineSkill({
    name: "research",
    description: "Find facts",
    instructions: "Use lookup before answering.",
    tools: [lookup],
    permissions: ["facts.read"],
    dependsOn: [citing],
    examples: [{ input: "capital of France?", output: "Paris [1]" }],
    evaluation: { cases: [{ id: "c1", input: "x" }] },
  });

  test("merge instructions, tools, permissions and verifiers in dependency order", () => {
    const agent = defineAgent({ name: "a", model, instructions: "Base.", skills: [research], permissions: ["x"] });
    const text = agent.config.instructions ?? "";
    expect(text.indexOf("## Skill: citing")).toBeLessThan(text.indexOf("## Skill: research"));
    expect(text).toContain("Example output: Paris [1]");
    expect(agent.config.tools?.map((t) => t.name)).toEqual(["lookup"]);
    expect(agent.config.permissions).toEqual(["x", "facts.read"]);
    expect(agent.config.reflection?.verifiers).toHaveLength(1);
    const again = defineAgent({ ...agent.config });
    expect(again.config.instructions).toBe(agent.config.instructions);
    expect(again.config.reflection?.verifiers).toHaveLength(1);
  });

  test("rejects invalid skills, cycles and conflicting tools", () => {
    expect(() => defineSkill({ name: "Bad Name", description: "d", instructions: "i" })).toThrow(ConfigurationError);
    const other = { name: "lookup", description: "other", parameters: {} };
    expect(() => defineAgent({ name: "a", model, tools: [other], skills: [research] })).toThrow(/different tool/);
    const a: { dependsOn: unknown[] } & Parameters<typeof defineSkill>[0] = { name: "a", description: "d", instructions: "i", dependsOn: [] };
    const b = { name: "b", description: "d", instructions: "i", dependsOn: [a] };
    a.dependsOn.push(b);
    expect(() => defineAgent({ name: "x", model, skills: [a] })).toThrow(/cycle/);
  });

  test("skill verifiers run during the agent run", async () => {
    const provider = createScriptedProvider([{ text: "Paris" }, { text: "Paris [1]" }]);
    const agent = defineAgent({ name: "a", model, skills: [citing], runtime: createRuntime({ providers: [provider] }) });
    expect((await agent.run({ input: "capital?" })).output).toBe("Paris [1]");
  });
});
