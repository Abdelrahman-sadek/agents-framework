import { createRuntime, defineAgent } from "@agent-farmework/core";
import { createScriptedProvider } from "@agent-farmework/core/testing";
import { defineDataset, defineEvaluation, evaluators } from "@agent-farmework/evaluation";
import { fileEventSink } from "@agent-farmework/observability";
import { SqliteRunStateStore, openSqlite } from "@agent-farmework/production";
import { ToolRuntime, defineTool } from "@agent-farmework/tools";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";

/** node:sqlite ships with Node ≥ 22.5; SQLite-backed tests are skipped on older runtimes. */
const hasSqlite = await import("node:sqlite").then(
  () => true,
  () => false,
);
import { z } from "zod";
import { runCli } from "./cli.js";
import { checkManifest, defineAgentFromManifest, parseManifest } from "./manifest.js";

function io(modules: Record<string, Record<string, unknown>> = {}, lines: string[] = []) {
  const cwd = mkdtempSync(join(tmpdir(), "af-cli-"));
  const out: string[] = [];
  const err: string[] = [];
  return {
    cwd,
    out,
    err,
    io: {
      cwd,
      out: (t: string) => out.push(t),
      err: (t: string) => err.push(t),
      load: async (path: string) => modules[path.split("/").at(-1) as string] ?? {},
      lines: async function* () {
        yield* lines;
      },
      exec: vi.fn(async () => 0),
    },
  };
}

const lookup = defineTool({ name: "lookup", description: "d", input: z.object({ key: z.string() }), permissions: ["facts.read"], execute: async () => "42" });

describe("agent create", () => {
  test("scaffolds agent, test, eval and manifest", async () => {
    const t = io();
    expect(await runCli(["create", "support-bot"], t.io)).toBe(0);
    for (const f of ["agent.ts", "agent.test.ts", "eval.ts", "agent.manifest.json"]) expect(existsSync(join(t.cwd, "agents/support-bot", f))).toBe(true);
    const manifest = parseManifest(JSON.parse(readFileSync(join(t.cwd, "agents/support-bot/agent.manifest.json"), "utf8")));
    expect(manifest.model).toEqual({ provider: "anthropic", model: "claude-opus-5" });
    expect(await runCli(["create", "support-bot"], t.io)).toBe(1);
    expect(await runCli(["create", "Bad Name"], t.io)).toBe(1);
  });
});

describe("agent dev / test / evaluate", () => {
  const makeAgent = (text: string) =>
    defineAgent({ name: "bot", model: { providerId: "scripted", modelId: "m" }, runtime: createRuntime({ providers: [createScriptedProvider([{ text }, { text }])] }) });

  test("dev runs one-shot and interactive sessions", async () => {
    const t = io({ "agent.ts": { agent: makeAgent("Hi there") } }, ["hello", ""]);
    expect(await runCli(["dev", "agent.ts", "--input", "hello"], t.io)).toBe(0);
    expect(t.out.join("")).toContain("Hi there");
    expect(t.out.join("")).toContain("[COMPLETED]");
    const t2 = io({ "agent.ts": { agent: makeAgent("Interactive") } }, ["hello", ""]);
    expect(await runCli(["dev", "agent.ts"], t2.io)).toBe(0);
    expect(t2.out.join("")).toContain("Interactive");
    expect(await runCli(["dev", "missing.ts"], t2.io)).toBe(1);
  });

  test("test delegates to vitest", async () => {
    const t = io();
    await runCli(["test", "agents/bot"], t.io);
    expect(t.io.exec).toHaveBeenCalledWith("npx", ["vitest", "run", "agents/bot"]);
  });

  test("evaluate prints a report, writes JSON and fails on regressions", async () => {
    const dataset = defineDataset("d", [{ id: "a", input: "x", expected: "hello" }]);
    const good = defineEvaluation({ name: "e", dataset, target: async () => ({ output: "hello" }), evaluators: [evaluators.contains()] });
    const bad = defineEvaluation({ name: "e", dataset, target: async () => ({ output: "bye" }), evaluators: [evaluators.contains()] });
    const t = io({ "good.ts": { evaluation: good }, "bad.ts": { evaluation: bad } });
    expect(await runCli(["evaluate", "good.ts", "--out", "baseline.json"], t.io)).toBe(0);
    expect(t.out.join("")).toContain("**PASSED**");
    expect(await runCli(["evaluate", "bad.ts", "--baseline", "baseline.json"], t.io)).toBe(1);
    expect(t.out.join("")).toContain("regression: case a now fails");
  });
});

describe.skipIf(!hasSqlite)("agent inspect / trace", () => {
  test("inspect reads persisted state; trace renders the event timeline", async () => {
    const t = io();
    const db = join(t.cwd, "runs.db");
    const eventsFile = join(t.cwd, "events.jsonl");
    const provider = createScriptedProvider([{ toolCalls: [{ id: "c1", name: "lookup", arguments: { key: "k" } }] }, { text: "It is 42." }]);
    const runtime = createRuntime({ providers: [provider], tools: new ToolRuntime(), stateStore: new SqliteRunStateStore(await openSqlite(db)), events: fileEventSink(eventsFile) });
    const agent = defineAgent({ name: "bot", model: { providerId: "scripted", modelId: "m" }, tools: [lookup], permissions: ["facts.read"], runtime });
    const result = await agent.run({ input: "?", runId: "run-1", user: { userId: "u", tenantId: "acme", permissions: ["facts.read"] } });
    expect(result.status).toBe("COMPLETED");

    expect(await runCli(["inspect", "run-1", "--db", "runs.db"], t.io)).toBe(0);
    const inspected = t.out.join("");
    expect(inspected).toContain("status=COMPLETED");
    expect(inspected).toContain("tool_call");
    expect(inspected).toContain("Output: It is 42.");

    t.out.length = 0;
    expect(await runCli(["trace", "run-1", "--events", "events.jsonl"], t.io)).toBe(0);
    expect(t.out.join("")).toContain("Tools: lookup(completed)");
    expect(await runCli(["trace", "nope", "--events", "events.jsonl"], t.io)).toBe(1);
    t.out.length = 0;
    expect(await runCli(["dashboard", "--events", "events.jsonl", "--port", "0"], { ...t.io, waitForExit: async () => {} })).toBe(0);
    expect(t.out.join("")).toMatch(/Dashboard: http:\/\/127\.0\.0\.1:\d+/);
    expect(await runCli(["inspect", "nope", "--db", "runs.db"], t.io)).toBe(1);
  });
});

describe("manifests", () => {
  const manifest = {
    name: "research-agent",
    version: "1.0.0",
    model: { provider: "anthropic", model: "claude-opus-5" },
    instructions: "Research.",
    tools: ["lookup"],
    security: { permissions: ["facts.read"] },
    limits: { maxSteps: 4 },
  };

  test("validate reports unknown references and permission mismatches", async () => {
    const t = io({ "registry.ts": { registry: { tools: { lookup } } } });
    writeFileSync(join(t.cwd, "ok.json"), JSON.stringify(manifest));
    writeFileSync(join(t.cwd, "bad.json"), JSON.stringify({ ...manifest, tools: ["lookup", "delete_all"], security: { permissions: ["admin.all"] } }));
    expect(await runCli(["validate", "ok.json", "--registry", "registry.ts"], t.io)).toBe(0);
    expect(await runCli(["validate", "bad.json", "--registry", "registry.ts"], t.io)).toBe(1);
    expect(t.err.join("")).toContain("Unknown tool 'delete_all'");
    expect(t.err.join("")).toContain("Tool permission 'facts.read' is not declared");
    expect(t.err.join("")).toContain("Declared permission 'admin.all' is not used");
    writeFileSync(join(t.cwd, "invalid.json"), JSON.stringify({ name: "x" }));
    expect(await runCli(["validate", "invalid.json"], t.io)).toBe(1);
  });

  test("defineAgentFromManifest builds a runnable agent", async () => {
    const provider = createScriptedProvider([{ text: "done" }], { id: "anthropic" });
    const runtime = createRuntime({ providers: [provider], tools: new ToolRuntime() });
    const agent = defineAgentFromManifest(manifest, { tools: { lookup } }, runtime);
    expect(agent).toMatchObject({ name: "research-agent", version: "1.0.0", config: { permissions: ["facts.read"], limits: { maxSteps: 4 } } });
    expect((await agent.run({ input: "x" })).output).toBe("done");
    expect(() => defineAgentFromManifest({ ...manifest, tools: ["ghost"] }, { tools: { lookup } })).toThrow(/Unknown tool 'ghost'/);
    expect(checkManifest(parseManifest(manifest), { tools: { lookup } })).toEqual([]);
  });

  test("help and unknown commands", async () => {
    const t = io();
    expect(await runCli([], t.io)).toBe(0);
    expect(t.out.join("")).toContain("agent create");
    expect(await runCli(["frobnicate"], t.io)).toBe(2);
  });
});

