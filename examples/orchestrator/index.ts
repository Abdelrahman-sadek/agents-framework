/**
 * Example 4 — Orchestrator:
 *
 *   Orchestrator
 *    ├── Research Worker   ┐ run in parallel
 *    ├── Data Worker       ┘
 *    └── Verification Worker (depends on both)
 *
 *   pnpm example:orchestrator
 */
import { createRuntime, defineAgent, InMemoryEventSink } from "@agent-framework/core";
import { createRuleProvider } from "@agent-framework/core/testing";
import { models } from "@agent-framework/llm";
import { defineOrchestrator, defineWorker, staticPlanner } from "@agent-framework/orchestration";
import { ToolRuntime, defineTool } from "@agent-framework/tools";
import { z } from "zod";

// Each worker is an agent with its own, narrow tools and permissions.
const salesQuery = defineTool({
  name: "sales_query",
  description: "Quarterly revenue in EUR millions for a region",
  input: z.object({ region: z.enum(["emea", "apac", "amer"]) }),
  permissions: ["sales.read"],
  execute: async ({ region }) => ({ region, q1: { emea: 12.4, apac: 8.1, amer: 20.3 }[region], q2: { emea: 13.9, apac: 7.2, amer: 21.0 }[region] }),
});

const model = createRuleProvider(
  [
    // data worker: call the tool, then report
    (_r, h) => (h.hasTool("sales_query") && h.toolResults["sales_query"] === undefined ? { toolCalls: [{ id: "q", name: "sales_query", arguments: { region: "emea" } }] } : undefined),
    (_r, h) => {
      const raw = h.toolResults["sales_query"];
      if (raw === undefined) return undefined;
      const d = JSON.parse(raw) as { q1: number; q2: number };
      return { text: `EMEA revenue grew from ${d.q1}M to ${d.q2}M (+${(((d.q2 - d.q1) / d.q1) * 100).toFixed(1)}%).` };
    },
    // research worker
    (_r, h) => (h.lastUser.includes("market news") ? { text: "Analysts report strong EMEA demand for cloud services in Q2." } : undefined),
    // verification worker: checks the two findings agree
    (_r, h) => (h.lastUser.includes("Verify") ? { text: h.lastUser.includes("grew") && h.lastUser.includes("strong") ? "VERIFIED: data and research agree on EMEA growth." : "REJECTED: findings disagree." } : undefined),
  ],
  { id: "anthropic" },
);

const runtime = createRuntime({ providers: [model], tools: new ToolRuntime() });
const agent = (name: string, extra: Partial<Parameters<typeof defineAgent>[0]> = {}) =>
  defineAgent({ name, model: models.anthropic("claude-sonnet-5"), instructions: `You are the ${name}.`, runtime, ...extra });

const events = new InMemoryEventSink();
const orchestrator = defineOrchestrator({
  name: "quarterly-review",
  planner: staticPlanner([
    { id: "research", description: "Summarize market news for EMEA", worker: "research" },
    { id: "data", description: "Compute EMEA revenue growth", worker: "data" },
    { id: "verify", description: "Verify that the findings are consistent", worker: "verification", dependsOn: ["research", "data"] },
  ]),
  workers: [
    defineWorker({ name: "research", description: "Market research", agent: agent("research-worker") }),
    defineWorker({ name: "data", description: "Sales data analysis", agent: agent("data-worker", { tools: [salesQuery], permissions: ["sales.read"] }) }),
    defineWorker({ name: "verification", description: "Cross-checks findings", agent: agent("verification-worker") }),
  ],
  maxParallel: 2,
  aggregate: ({ outputs }) => ({ research: outputs["research"], data: outputs["data"], verdict: outputs["verify"] }),
  events: [events],
});

const result = await orchestrator.run({ input: "Quarterly EMEA review", user: { userId: "cfo", tenantId: "acme", permissions: ["sales.read"] } });
console.log(`status: ${result.status}`);
console.log(JSON.stringify(result.output, null, 2));
console.log("\nexecution:");
for (const e of events.events) {
  if (e.type === "WORKER_SCHEDULED" || e.type === "WORKER_COMPLETED") console.log(`  ${e.type.padEnd(17)} ${e.payload.planStepId}`);
}
