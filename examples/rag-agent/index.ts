/**
 * Example 3 — RAG agent: Question → Knowledge retrieval → Context → LLM → Cited answer.
 *
 *   pnpm example:rag
 */
import { citationVerifier, createRuntime, defineAgent, InMemoryEventSink } from "@agent-farmework/core";
import { createRuleProvider } from "@agent-farmework/core/testing";
import { createKnowledgeBase, hashingEmbedder } from "@agent-farmework/knowledge";
import { models } from "@agent-farmework/llm";
import { piiGuardrail, promptInjectionGuardrail } from "@agent-farmework/security";

// 1. Ingest documents (chunking, metadata, embeddings). Tenant documents stay inside their tenant.
const handbook = createKnowledgeBase({ name: "handbook", embedder: hashingEmbedder() });
await handbook.ingest([
  { id: "leave-policy", title: "Leave policy", uri: "https://intranet.example/leave", text: "Full-time employees receive 25 days of paid vacation per calendar year. Up to 5 unused days carry over until March 31." },
  { id: "expense-policy", title: "Expense policy", uri: "https://intranet.example/expenses", text: "Travel expenses above 500 EUR require manager approval before booking. Submit receipts within 30 days." },
  { id: "acme-bonus", title: "Acme vacation bonus", tenantId: "acme", text: "Acme employees receive 3 additional vacation days after five years of service." },
]);

// 2. A stand-in model that answers from the reference block and cites it. Swap for anthropicProvider().
const model = createRuleProvider(
  [
    (_req, h) => {
      const match = /\[(\d+)\] \(knowledge: ([^)]+)\)\n([^\n]+)/.exec(h.context);
      return match === null ? { text: "I could not find this in the handbook." } : { text: `${match[3]} [${match[1]}]` };
    },
  ],
  { id: "anthropic" },
);

const events = new InMemoryEventSink();
const agent = defineAgent({
  name: "hr-assistant",
  model: models.anthropic("claude-opus-5"),
  instructions: "Answer HR questions using only the reference material. Cite sources as [n]. Say so if the answer is not there.",
  context: [handbook.asContextProvider({ k: 3, minScore: 0.2 })],
  guardrails: [piiGuardrail(), promptInjectionGuardrail()],
  reflection: { verifiers: [citationVerifier()] }, // every answer must cite a provided source
  runtime: createRuntime({ providers: [model], events }),
});

const result = await agent.run({
  input: "How many vacation days do I get? My email is sam@acme.com",
  user: { userId: "sam", tenantId: "globex" },
});

console.log(`status: ${result.status}`);
console.log(`answer: ${result.output}`);
const retrieval = events.ofType("RETRIEVAL_COMPLETED")[0]?.payload;
console.log(`retrieved: ${retrieval?.resultCount} chunk(s), top score ${retrieval?.topScore?.toFixed(3)}`);
console.log(`guardrails: ${events.ofType("GUARDRAIL_TRIGGERED").map((e) => `${e.payload.guardrail}:${e.payload.action}`).join(", ") || "none"}`);
const state = await agent.config.runtime?.getState(result.runId);
console.log("sources:");
for (const item of state?.contextItems ?? []) console.log(`  - ${item.source?.title} (chunk ${item.source?.chunkId}) score ${item.score?.toFixed(3)}`);
