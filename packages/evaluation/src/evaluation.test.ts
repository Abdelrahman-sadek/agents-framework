import { createRuntime, defineAgent } from "@agent-farmework/core";
import { createScriptedProvider } from "@agent-farmework/core/testing";
import { createKnowledgeBase, hashingEmbedder } from "@agent-farmework/knowledge";
import { piiGuardrail } from "@agent-farmework/security";
import { ToolRuntime, defineTool } from "@agent-farmework/tools";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { compareReports, defineDataset, defineEvaluation, evaluators, formatReport, type Observation } from "./evaluation.js";

const obs = (over: Partial<Observation>): Observation => ({
  case: { id: "c", input: "q" },
  status: "COMPLETED",
  output: "",
  text: "",
  latencyMs: 10,
  costUsd: 0,
  tokens: 0,
  toolCalls: [],
  retrievedDocuments: [],
  contextTexts: [],
  events: [],
  ...over,
});

describe("deterministic evaluators", () => {
  test("exact match, contains, regex, schema", async () => {
    expect(await evaluators.exactMatch().evaluate(obs({ output: " Paris ", case: { id: "c", input: "", expected: "paris" } }))).toMatchObject({ passed: true });
    expect(await evaluators.contains().evaluate(obs({ text: "Paris is in France", case: { id: "c", input: "", expected: ["paris", "germany"] } }))).toMatchObject({ score: 0.5, passed: false });
    expect(await evaluators.regex(/\d{4}/).evaluate(obs({ text: "in 2024" }))).toMatchObject({ passed: true });
    expect(await evaluators.jsonSchema(z.object({ a: z.number() })).evaluate(obs({ output: '{"a":"x"}' }))).toMatchObject({ passed: false });
  });

  test("tool usage, retrieval, groundedness, safety, cost, latency", async () => {
    expect(await evaluators.toolUsage().evaluate(obs({ toolCalls: ["search"], case: { id: "c", input: "", expectedTools: ["search", "calc"] } }))).toMatchObject({ score: 0.5, passed: false });
    expect(await evaluators.toolUsage().evaluate(obs({ toolCalls: ["search", "delete"], case: { id: "c", input: "", forbiddenTools: ["delete"] } }))).toMatchObject({ score: 0, passed: false });
    expect(await evaluators.retrievalRecall({ k: 2 }).evaluate(obs({ retrievedDocuments: ["a", "b", "c"], case: { id: "c", input: "", relevantDocuments: ["b", "c"] } }))).toMatchObject({ score: 0.5 });
    expect(await evaluators.groundedness().evaluate(obs({ text: "Vacation is 25 days. Unicorns fly daily.", contextTexts: ["Employees get 25 vacation days"] }))).toMatchObject({ score: 0.5, passed: false });
    expect(await evaluators.safety([piiGuardrail()]).evaluate(obs({ text: "email me at a@b.co" }))).toMatchObject({ passed: false });
    expect(await evaluators.cost(0.01).evaluate(obs({ costUsd: 0.02 }))).toMatchObject({ score: 0.5, passed: false });
    expect(await evaluators.latency(100).evaluate(obs({ latencyMs: 50 }))).toMatchObject({ passed: true });
  });

  test("LLM judge parses a bounded score", async () => {
    const judge = createScriptedProvider([{ text: '{"score": 1.4, "reason": "great"}' }, { text: "nonsense" }]);
    const e = evaluators.llmJudge({ provider: judge, modelId: "judge", rubric: "Be correct." });
    expect(await e.evaluate(obs({ text: "a" }))).toEqual({ score: 1, passed: true, reason: "great" });
    expect(await e.evaluate(obs({ text: "a" }))).toMatchObject({ passed: false });
  });
});

describe("agent evaluation", () => {
  async function ragAgent(answers: string[]) {
    const kb = createKnowledgeBase({ name: "hr", embedder: hashingEmbedder() });
    await kb.ingest([
      { id: "leave", title: "Leave", text: "Employees get 25 vacation days per year." },
      { id: "expenses", title: "Expenses", text: "Expenses above 500 EUR need approval." },
    ]);
    const calculator = defineTool({ name: "calc", description: "add", input: z.object({ a: z.number(), b: z.number() }), execute: ({ a, b }) => a + b });
    const provider = createScriptedProvider(
      answers.map((text) => (request) => ({ id: "x", modelId: request.modelId, content: text, toolCalls: [], finishReason: "stop" as const, usage: { inputTokens: 50, outputTokens: 10 } })),
      { capabilities: { pricing: { currency: "USD", inputPerMillionTokens: 1, outputPerMillionTokens: 1 } } },
    );
    const runtime = createRuntime({ providers: [provider], tools: new ToolRuntime() });
    return defineAgent({ name: "hr-bot", model: { providerId: "scripted", modelId: "m" }, context: [kb.asContextProvider({ k: 1 })], tools: [calculator], runtime });
  }

  const dataset = defineDataset("hr-golden", [
    { id: "vacation", input: "How many vacation days?", expected: "25", relevantDocuments: ["leave"] },
    { id: "expenses", input: "When do expenses need approval?", expected: "500", relevantDocuments: ["expenses"] },
  ]);

  test("runs a dataset against an agent and produces a report", async () => {
    const agent = await ragAgent(["Employees get 25 vacation days per year.", "Expenses above 500 EUR need approval."]);
    const evaluation = defineEvaluation({
      name: "hr-regression",
      dataset,
      target: agent,
      concurrency: 1,
      evaluators: [evaluators.status(), evaluators.contains(), evaluators.retrievalRecall({ k: 1 }), evaluators.groundedness(), evaluators.cost(0.01)],
      thresholds: { minPassRate: 1, minMeanScore: { groundedness: 0.9 } },
    });
    const report = await evaluation.run();
    expect(report.passed).toBe(true);
    expect(report.summary).toMatchObject({ cases: 2, passed: 2, passRate: 1, totalTokens: 120 });
    expect(report.summary.meanScores["retrieval_recall"]).toBe(1);
    const md = formatReport(report);
    expect(md).toContain("**PASSED**");
    expect(md).toContain("| ✅ vacation | COMPLETED |");
  });

  test("threshold failures and regression comparison", async () => {
    const good = await defineEvaluation({ name: "e", dataset, target: await ragAgent(["25 days.", "Above 500 EUR."]), concurrency: 1, evaluators: [evaluators.contains()] }).run();
    const bad = await defineEvaluation({ name: "e", dataset, target: await ragAgent(["25 days.", "No idea."]), concurrency: 1, evaluators: [evaluators.contains()], thresholds: { minPassRate: 0.9 } }).run();
    expect(bad.passed).toBe(false);
    expect(bad.failures[0]).toContain("pass rate 50.0%");
    const diff = compareReports(good, bad);
    expect(diff.passed).toBe(false);
    expect(diff.regressions).toEqual(expect.arrayContaining(["case expenses now fails"]));
  });

  test("function targets and evaluator errors", async () => {
    const report = await defineEvaluation({
      name: "fn",
      dataset: defineDataset("d", [{ id: "a", input: 2, expected: "4" }]),
      target: async (c) => ({ output: String((c.input as number) * 2) }),
      evaluators: [evaluators.exactMatch(), { name: "broken", evaluate: () => { throw new Error("x"); } }],
    }).run();
    expect(report.cases[0]?.scores).toMatchObject({ exact_match: { passed: true }, broken: { passed: false } });
  });

  test("rejects invalid configuration", () => {
    expect(() => defineDataset("d", [])).toThrow();
    expect(() => defineDataset("d", [{ id: "a", input: 1 }, { id: "a", input: 2 }])).toThrow(/duplicate/);
    expect(() => defineEvaluation({ name: "e", dataset, target: async () => ({ output: 1 }), evaluators: [] })).toThrow();
  });
});

describe("skill evaluation", () => {
  test("a skill's declared cases become a dataset", async () => {
    const { defineSkill } = await import("@agent-farmework/core");
    const { skillDataset } = await import("./evaluation.js");
    const skill = defineSkill({ name: "math", description: "Arithmetic", instructions: "Compute.", evaluation: { cases: [{ id: "add", input: "1+1", expected: "2" }] } });
    const report = await defineEvaluation({ name: "skill", dataset: skillDataset(skill), target: async () => ({ output: "2" }), evaluators: [evaluators.contains()] }).run();
    expect(report.passed).toBe(true);
    expect(() => skillDataset(defineSkill({ name: "empty", description: "d", instructions: "i" }))).toThrow(/no evaluation cases/);
  });
});
