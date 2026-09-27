/**
 * Example 2 — Research agent: Plan → Search → Retrieve → Analyze → Verify → Report.
 *
 * A model-proposed plan (validated before it runs), a search tool over a
 * knowledge base, an analyst agent with a typed report schema, and a rule
 * verifier on the final report.
 *
 *   pnpm example:research
 */
import { createRuntime, defineAgent, ruleVerifier } from "@agent-farmework/core";
import { createRuleProvider } from "@agent-farmework/core/testing";
import { createKnowledgeBase, hashingEmbedder } from "@agent-farmework/knowledge";
import { models } from "@agent-farmework/llm";
import { defineOrchestrator, defineWorker, llmPlanner } from "@agent-farmework/orchestration";
import { ToolRuntime } from "@agent-farmework/tools";
import { z } from "zod";

const sources = createKnowledgeBase({ name: "papers", embedder: hashingEmbedder() });
await sources.ingest([
  { id: "p1", title: "Vector DB benchmark 2026", text: "At 10M vectors, HNSW-based stores kept p95 latency under 20 ms with 95% recall." },
  { id: "p2", title: "Postgres pgvector at scale", text: "pgvector with HNSW indexes reached 0.93 recall at 10M rows with p95 of 35 ms on a single node." },
  { id: "p3", title: "Cost study", text: "Managed vector databases cost roughly 3x more than self-hosted pgvector at 10M vectors." },
]);

const Report = z.object({ summary: z.string(), findings: z.array(z.string()).min(2), confidence: z.number().min(0).max(1) });

const model = createRuleProvider(
  [
    // planner
    (req) =>
      req.responseFormat !== undefined && req.messages[0]?.content.includes("You plan work")
        ? { text: JSON.stringify({ steps: [{ id: "search", description: "Find evidence on vector databases at 10M scale", worker: "searcher" }, { id: "report", description: "Write the report", worker: "analyst", dependsOn: ["search"] }] }) }
        : undefined,
    // searcher: search, then return the passages
    (_r, h) => (h.hasTool("search_papers") && h.toolResults["search_papers"] === undefined ? { toolCalls: [{ id: "s", name: "search_papers", arguments: { query: "vector database latency recall cost 10M" } }] } : undefined),
    (_r, h) => (h.toolResults["search_papers"] !== undefined ? { text: h.toolResults["search_papers"] } : undefined),
    // analyst: typed report
    () => ({
      text: JSON.stringify({
        summary: "For ~10M vectors, self-hosted pgvector is the cost-efficient default; a dedicated HNSW store buys lower latency.",
        findings: ["Dedicated HNSW stores: p95 < 20 ms at 95% recall (p1)", "pgvector: 0.93 recall, p95 35 ms (p2)", "Managed options cost ~3x more (p3)"],
        confidence: 0.8,
      }),
    }),
  ],
  { id: "anthropic" },
);

const runtime = createRuntime({ providers: [model], tools: new ToolRuntime() });
const searcher = defineAgent({ name: "searcher", model: models.anthropic("claude-haiku-4-5"), instructions: "Search and return raw evidence.", tools: [sources.asTool({ name: "search_papers", k: 3 })], runtime });
const analyst = defineAgent({
  name: "analyst",
  model: models.anthropic("claude-opus-5"),
  instructions: "Write a report as JSON {summary, findings[], confidence}. Every finding cites a source id.",
  output: Report,
  reflection: { verifiers: [ruleVerifier("cites-sources", ({ output }) => ((output as z.infer<typeof Report>).findings.every((f) => /\(p\d\)/.test(f)) ? true : "Every finding must cite a source id like (p1)."))] },
  runtime,
});

const research = defineOrchestrator({
  name: "research",
  planner: llmPlanner({ provider: model, modelId: "claude-opus-5" }),
  workers: [
    defineWorker({ name: "searcher", description: "Finds evidence in the paper collection", agent: searcher }),
    defineWorker({ name: "analyst", description: "Writes the final structured report", agent: analyst }),
  ],
});

const result = await research.run({ input: "Which vector database should we use for 10M documents?" });
console.log(`status: ${result.status}  plan: ${result.plan?.steps.map((s) => s.id).join(" → ")}`);
console.log(JSON.stringify(result.output, null, 2));
