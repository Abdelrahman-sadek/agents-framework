import { ExecutionError, InMemoryEventSink, createRuntime, defineAgent, ruleVerifier, sequentialIds } from "@agent-farmework/core";
import { createScriptedProvider } from "@agent-farmework/core/testing";
import { ToolRuntime } from "@agent-farmework/tools";
import { describe, expect, test, vi } from "vitest";
import { agentAsTool, agentVerifier, runParallel, runPipeline, supervisor } from "./multi-agent.js";
import { defineOrchestrator } from "./orchestrator.js";
import { llmPlanner, staticPlanner, validatePlan, type PlanStep } from "./plan.js";
import { defineWorker } from "./worker.js";

const echo = (name: string, fn: (t: { description: string; dependencies: Record<string, unknown> }) => unknown = (t) => `${name}:${t.description}`) =>
  defineWorker({ name, description: `${name} worker`, handler: (task) => fn(task as never) });

describe("plan validation", () => {
  const workers = new Set(["a"]);
  test.each([
    [[], /no steps/],
    [[{ id: "1", description: "d", worker: "x" }], /unknown worker/],
    [[{ id: "1", description: "d", worker: "a", dependsOn: ["2"] }], /unknown step/],
    [[{ id: "1", description: "d", worker: "a" }, { id: "1", description: "d", worker: "a" }], /Duplicate/],
    [[{ id: "1", description: "d", worker: "a", dependsOn: ["2"] }, { id: "2", description: "d", worker: "a", dependsOn: ["1"] }], /cycle/],
  ])("rejects invalid plan %#", (steps, message) => {
    expect(() => validatePlan(steps as PlanStep[], workers, 10)).toThrow(message);
  });

  test("enforces the step limit", () => {
    const steps = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, description: "d", worker: "a" }));
    expect(() => validatePlan(steps, workers, 4)).toThrow(/limit is 4/);
  });
});

describe("orchestrator", () => {
  test("runs a DAG with parallel steps and passes dependency outputs", async () => {
    const order: string[] = [];
    let active = 0;
    let peak = 0;
    const slow = (name: string) =>
      defineWorker({
        name,
        description: name,
        handler: async (task) => {
          active += 1;
          peak = Math.max(peak, active);
          order.push(task.planStepId);
          await new Promise((r) => setTimeout(r, 10));
          active -= 1;
          return `${task.planStepId}(${Object.keys(task.dependencies).join(",")})`;
        },
      });
    const sink = new InMemoryEventSink();
    const orchestrator = defineOrchestrator({
      name: "research",
      planner: staticPlanner([
        { id: "search", description: "search", worker: "research" },
        { id: "data", description: "data", worker: "data" },
        { id: "analyze", description: "analyze", worker: "analysis", dependsOn: ["search", "data"] },
      ]),
      workers: [slow("research"), slow("data"), slow("analysis")],
      events: [sink],
      ids: sequentialIds(),
    });
    const result = await orchestrator.run({ input: "Market report" });
    expect(result).toMatchObject({ status: "COMPLETED", output: "analyze(search,data)" });
    expect(peak).toBe(2);
    expect(order.at(-1)).toBe("analyze");
    expect(sink.events.map((e) => e.type)).toEqual(expect.arrayContaining(["ORCHESTRATION_STARTED", "PLAN_CREATED", "WORKER_SCHEDULED", "WORKER_COMPLETED", "ORCHESTRATION_COMPLETED"]));
  });

  test("respects maxParallel", async () => {
    let active = 0;
    let peak = 0;
    const w = defineWorker({
      name: "w",
      description: "w",
      handler: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
      },
    });
    const steps = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, description: "d", worker: "w" }));
    await defineOrchestrator({ name: "o", planner: staticPlanner(steps), workers: [w], maxParallel: 2 }).run({ input: "x" });
    expect(peak).toBe(2);
  });

  test("retries retryable worker failures", async () => {
    let calls = 0;
    const flaky = defineWorker({
      name: "flaky",
      description: "d",
      handler: () => {
        calls += 1;
        if (calls < 2) throw new ExecutionError("transient", { retryable: true });
        return "ok";
      },
    });
    const result = await defineOrchestrator({ name: "o", planner: staticPlanner([{ id: "s", description: "d", worker: "flaky", retry: { maxAttempts: 2 } }]), workers: [flaky] }).run({ input: "x" });
    expect(result).toMatchObject({ status: "COMPLETED", steps: { s: { attempts: 2 } } });
  });

  test("re-plans after a failure, keeping completed work", async () => {
    const plans: PlanStep[][] = [
      [
        { id: "fetch", description: "fetch", worker: "fetcher" },
        { id: "parse", description: "parse", worker: "strictParser", dependsOn: ["fetch"] },
      ],
      [
        { id: "fetch", description: "fetch", worker: "fetcher" },
        { id: "parse2", description: "parse leniently", worker: "lenientParser", dependsOn: ["fetch"] },
      ],
    ];
    const planner = { plan: vi.fn(async (_request: unknown) => plans.shift() ?? []) };
    const fetcher = vi.fn(() => "raw");
    const result = await defineOrchestrator({
      name: "o",
      planner,
      workers: [
        defineWorker({ name: "fetcher", description: "d", handler: fetcher }),
        defineWorker({ name: "strictParser", description: "d", handler: () => { throw new Error("bad format"); } }),
        defineWorker({ name: "lenientParser", description: "d", handler: (t) => `parsed ${String(t.dependencies["fetch"])}` }),
      ],
    }).run({ input: "x" });
    expect(result).toMatchObject({ status: "COMPLETED", output: "parsed raw", replans: 1 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(planner.plan.mock.calls[1]?.[0]).toMatchObject({ previous: { failure: expect.stringContaining("bad format") } });
  });

  test("fails after maxReplans, skipping dependents", async () => {
    const result = await defineOrchestrator({
      name: "o",
      planner: staticPlanner([
        { id: "a", description: "d", worker: "bad" },
        { id: "b", description: "d", worker: "ok", dependsOn: ["a"] },
      ]),
      workers: [defineWorker({ name: "bad", description: "d", handler: () => { throw new Error("boom"); } }), echo("ok")],
      maxReplans: 0,
    }).run({ input: "x" });
    expect(result.status).toBe("FAILED");
    expect(result.error?.message).toContain("boom");
    expect(result.steps["b"]?.status).toBe("SKIPPED");
  });

  test("continue policy returns partial results", async () => {
    const result = await defineOrchestrator({
      name: "o",
      planner: staticPlanner([
        { id: "a", description: "d", worker: "bad" },
        { id: "b", description: "d", worker: "ok" },
      ]),
      workers: [defineWorker({ name: "bad", description: "d", handler: () => { throw new Error("x"); } }), echo("ok")],
      onStepFailure: "continue",
    }).run({ input: "x" });
    expect(result).toMatchObject({ status: "COMPLETED", output: "ok:d" });
  });

  test("step timeouts and cancellation", async () => {
    const hang = defineWorker({ name: "hang", description: "d", handler: () => new Promise(() => {}) });
    const timed = await defineOrchestrator({ name: "o", planner: staticPlanner([{ id: "s", description: "d", worker: "hang" }]), workers: [hang], stepTimeoutMs: 10, onStepFailure: "fail" }).run({ input: "x" });
    expect(timed.status).toBe("FAILED");
    const controller = new AbortController();
    const pending = defineOrchestrator({ name: "o", planner: staticPlanner([{ id: "s", description: "d", worker: "hang" }]), workers: [hang] }).run({ input: "x", signal: controller.signal });
    controller.abort();
    expect((await pending).status).toBe("CANCELLED");
  });

  test("aggregates and verifies the result", async () => {
    const orchestrator = defineOrchestrator({
      name: "o",
      planner: staticPlanner([
        { id: "a", description: "d", worker: "ok" },
        { id: "b", description: "d", worker: "ok" },
      ]),
      workers: [echo("ok", (t) => t.description.length)],
      aggregate: ({ outputs }) => Object.values(outputs).reduce((s: number, v) => s + (v as number), 0),
      verifiers: [ruleVerifier("positive", ({ output }) => ((output as number) > 5 ? true : "too small"))],
    });
    const result = await orchestrator.run({ input: "x" });
    expect(result).toMatchObject({ status: "FAILED", error: { code: "VERIFICATION_FAILED" } });
  });

  test("llmPlanner output is validated before execution", async () => {
    const provider = createScriptedProvider([
      { text: '{"steps":[{"id":"s1","description":"look up","worker":"research"},{"id":"s2","description":"write","worker":"writer","dependsOn":["s1"]}]}' },
    ]);
    const result = await defineOrchestrator({
      name: "o",
      planner: llmPlanner({ provider, modelId: "planner" }),
      workers: [echo("research"), echo("writer", (t) => `report from ${String(t.dependencies["s1"])}`)],
    }).run({ input: "Write a report" });
    expect(result).toMatchObject({ status: "COMPLETED", output: "report from research:look up" });
    expect(provider.requests[0]?.messages[0]?.content).toContain("- research: research worker");

    const hallucinated = createScriptedProvider([{ text: '{"steps":[{"id":"s1","description":"d","worker":"hacker"}]}' }]);
    const bad = await defineOrchestrator({ name: "o", planner: llmPlanner({ provider: hallucinated, modelId: "p" }), workers: [echo("research")] }).run({ input: "x" });
    expect(bad).toMatchObject({ status: "FAILED", error: { code: "PLANNING_ERROR", message: expect.stringContaining("unknown worker 'hacker'") } });
  });

  test("agent workers see only their task (isolated context) and run with the user", async () => {
    const provider = createScriptedProvider([{ text: "summary" }]);
    const runtime = createRuntime({ providers: [provider] });
    const agent = defineAgent({ name: "summarizer", model: { providerId: "scripted", modelId: "m" }, runtime });
    const result = await defineOrchestrator({
      name: "o",
      planner: staticPlanner([{ id: "s", description: "Summarize the findings", worker: "summarizer" }]),
      workers: [defineWorker({ name: "summarizer", description: "d", agent })],
    }).run({ input: "SECRET original request", goal: "Summarize research", user: { userId: "u" } });
    expect(result.output).toBe("summary");
    const prompt = provider.requests[0]?.messages.at(-1)?.content ?? "";
    expect(prompt).toContain("Summarize the findings");
    expect(prompt).not.toContain("SECRET");
  });
});

describe("multi-agent patterns", () => {
  const agentWith = (name: string, steps: Parameters<typeof createScriptedProvider>[0], tools?: ToolRuntime) => {
    const provider = createScriptedProvider(steps, { id: `p-${name}` });
    const runtime = createRuntime({ providers: [provider], ...(tools === undefined ? {} : { tools }) });
    return { provider, runtime, agent: defineAgent({ name, model: { providerId: `p-${name}`, modelId: "m" }, runtime }) };
  };

  test("supervisor delegates to a specialist through the tool runtime", async () => {
    const specialist = agentWith("tax-expert", [{ text: "VAT is 14%." }]);
    const provider = createScriptedProvider([{ toolCalls: [{ id: "c1", name: "ask_tax-expert", arguments: { task: "What is the VAT rate?" } }] }, { text: "The VAT rate is 14%." }], { id: "sup" });
    const runtime = createRuntime({ providers: [provider], tools: new ToolRuntime() });
    const boss = supervisor({ name: "boss", model: { providerId: "sup", modelId: "m" }, specialists: [{ agent: specialist.agent, description: "Answers tax questions" }], runtime });
    const result = await boss.run({ input: "VAT?", user: { userId: "u" } });
    expect(result.output).toBe("The VAT rate is 14%.");
    expect(specialist.provider.requests[0]?.messages.at(-1)?.content).toBe("What is the VAT rate?");
  });

  test("delegation depth is bounded", async () => {
    // An agent that delegates to itself: the nested call at depth 2 exceeds maxDepth 1.
    const provider = createScriptedProvider(
      [
        { toolCalls: [{ id: "outer", name: "ask_self", arguments: { task: "again" } }] },
        { toolCalls: [{ id: "nested", name: "ask_self", arguments: { task: "again" } }] },
        { text: "nested done" },
        { text: "outer done" },
      ],
      { id: "loop" },
    );
    const runtime = createRuntime({ providers: [provider], tools: new ToolRuntime() });
    const holder: { agent?: ReturnType<typeof defineAgent<unknown>> } = {};
    const proxy = { name: "self", run: (o: never) => (holder.agent as NonNullable<typeof holder.agent>).run(o) } as never;
    holder.agent = defineAgent<unknown>({ name: "self", model: { providerId: "loop", modelId: "m" }, tools: [agentAsTool(proxy, { name: "ask_self", description: "recurse", maxDepth: 1 })], runtime });
    const result = await holder.agent.run({ input: "go" });
    expect(result.output).toBe("outer done");
    expect(provider.requests[2]?.messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "nested", isError: true, content: expect.stringContaining("LIMIT_EXCEEDED") });
  });

  test("pipeline and parallel patterns", async () => {
    const a = agentWith("draft", [{ text: "draft text" }]);
    const b = agentWith("edit", [{ text: "edited text" }]);
    const pipe = await runPipeline([a.agent, b.agent], { input: "topic" });
    expect(pipe).toMatchObject({ status: "COMPLETED", output: "edited text" });
    expect(b.provider.requests[0]?.messages.at(-1)?.content).toBe("draft text");

    const x = agentWith("optimist", [{ text: "up" }]);
    const y = agentWith("pessimist", [{ text: "down" }]);
    const par = await runParallel([x.agent, y.agent], { input: "market?" });
    expect(par.output).toEqual({ optimist: "up", pessimist: "down" });
  });

  test("agentVerifier: cross-agent review", async () => {
    const reviewer = agentWith("reviewer", [{ text: '{"passed":false,"feedback":"Missing source"}' }]);
    const verdict = await agentVerifier(reviewer.agent).verify({ runId: "r", agentId: "a", input: "q", text: "answer", output: "answer", contextItems: [], messages: [], signal: new AbortController().signal });
    expect(verdict).toEqual({ passed: false, feedback: "Missing source" });
  });
});
