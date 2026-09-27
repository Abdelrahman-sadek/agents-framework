import { InMemoryEventSink, citationVerifier, createRuntime, defineAgent } from "@agent-farmework/core";
import { createScriptedProvider } from "@agent-farmework/core/testing";
import { ToolRuntime } from "@agent-farmework/tools";
import { describe, expect, test } from "vitest";
import { fixedSizeChunker, htmlToText, recursiveChunker } from "./chunking.js";
import { hashingEmbedder } from "./embedding.js";
import { createKnowledgeBase, lexicalReranker } from "./knowledge-base.js";
import { bm25 } from "./stores.js";
import type { Document } from "./types.js";

const docs: Document[] = [
  { id: "leave", title: "Leave policy", text: "Employees receive 25 days of paid vacation per year. Unused vacation days expire in March.", metadata: { dept: "hr" } },
  { id: "expenses", title: "Expense policy", text: "Travel expenses above 500 EUR require manager approval. Receipts must be submitted within 30 days.", metadata: { dept: "finance" } },
  { id: "security", title: "Security policy", text: "Passwords must be rotated every 90 days. Multi-factor authentication is mandatory for VPN access.", metadata: { dept: "it" } },
  { id: "acme-only", title: "Acme bonus", text: "Acme employees receive a vacation bonus of 3 extra days.", tenantId: "acme" },
];

async function kb() {
  const base = createKnowledgeBase({ name: "handbook", embedder: hashingEmbedder() });
  await base.ingest(docs);
  return base;
}

describe("chunking", () => {
  test("fixed-size windows overlap", () => {
    const chunks = fixedSizeChunker({ size: 10, overlap: 3 }).chunk({ id: "d", text: "abcdefghijklmnopqrstuvwxyz" });
    expect(chunks.map((c) => c.text)).toEqual(["abcdefghij", "hijklmnopq", "opqrstuvwx", "vwxyz"]);
    expect(chunks[1]).toMatchObject({ id: "d#1", documentId: "d", index: 1 });
  });

  test("recursive chunker respects paragraphs and size", () => {
    const text = "# A\nFirst paragraph here.\n\n# B\nSecond paragraph. It has two sentences.";
    const chunks = recursiveChunker({ maxChars: 30 }).chunk({ id: "d", text, title: "T", metadata: { x: 1 } });
    expect(chunks.every((c) => c.text.length <= 30)).toBe(true);
    expect(chunks[0]).toMatchObject({ title: "T", metadata: { x: 1 } });
  });

  test("htmlToText strips markup and scripts", () => {
    expect(htmlToText("<h1>Hi</h1><script>evil()</script><p>a &amp; b</p>")).toBe("Hi\n a & b");
  });
});

describe("retrieval", () => {
  test("hybrid search finds the relevant document with a citation", async () => {
    const results = await (await kb()).search("how many vacation days do I get", { k: 2 });
    expect(results[0]?.citation).toMatchObject({ documentId: "leave", title: "Leave policy" });
    expect(results[0]?.score).toBeGreaterThan(0);
  });

  test("vector and keyword modes work independently", async () => {
    const base = await kb();
    expect((await base.search("VPN authentication", { mode: "keyword" }))[0]?.chunk.documentId).toBe("security");
    expect((await base.search("expenses approval manager", { mode: "vector" }))[0]?.chunk.documentId).toBe("expenses");
  });

  test("metadata filters restrict results", async () => {
    const results = await (await kb()).search("policy", { filter: { dept: ["it", "finance"] }, k: 10 });
    expect(new Set(results.map((r) => r.chunk.documentId))).toEqual(new Set(["security", "expenses"]));
  });

  test("tenant documents are invisible to other tenants and to unscoped searches", async () => {
    const base = await kb();
    const ids = async (tenantId?: string) =>
      (await base.search("vacation bonus extra days", { k: 10, ...(tenantId === undefined ? {} : { tenantId }) })).map((r) => r.chunk.documentId);
    expect(await ids("acme")).toContain("acme-only");
    expect(await ids("globex")).not.toContain("acme-only");
    expect(await ids()).not.toContain("acme-only");
  });

  test("re-ingesting a document replaces it; remove deletes it", async () => {
    const base = await kb();
    await base.ingest([{ id: "leave", text: "Vacation is now 30 days." }]);
    const hits = await base.search("vacation days", { k: 10 });
    expect(hits.filter((h) => h.chunk.documentId === "leave").map((h) => h.chunk.text)).toEqual(["Vacation is now 30 days."]);
    await base.remove("leave");
    expect((await base.search("vacation", { k: 10 })).some((h) => h.chunk.documentId === "leave")).toBe(false);
  });

  test("minScore drops weak matches; reranker reorders", async () => {
    const base = createKnowledgeBase({ name: "kb", embedder: hashingEmbedder(), reranker: lexicalReranker });
    await base.ingest(docs);
    const results = await base.search("receipts submitted", { minScore: 0.3 });
    expect(results.every((r) => r.score >= 0.3)).toBe(true);
    expect(results[0]?.chunk.documentId).toBe("expenses");
  });

  test("bm25 ignores chunks without query terms", () => {
    const chunks = docs.map((d, i) => ({ id: String(i), documentId: d.id, index: 0, text: d.text, metadata: {} }));
    expect(bm25("passwords", chunks, 5).map((r) => r.chunk.documentId)).toEqual(["security"]);
  });
});

describe("RAG agent", () => {
  test("context provider feeds cited evidence into the run", async () => {
    const provider = createScriptedProvider([{ text: "You get 25 days of paid vacation [1]." }]);
    const sink = new InMemoryEventSink();
    const runtime = createRuntime({ providers: [provider], events: sink });
    const agent = defineAgent({
      name: "hr-assistant",
      model: { providerId: "scripted", modelId: "m" },
      context: [(await kb()).asContextProvider({ k: 2 })],
      reflection: { verifiers: [citationVerifier()] },
      runtime,
    });
    const result = await agent.run({ input: "How many vacation days do I get?", user: { userId: "u", tenantId: "globex" } });
    expect(result.status).toBe("COMPLETED");
    const contextMessage = provider.requests[0]?.messages.find((m) => m.content.includes("<context>"));
    expect(contextMessage?.content).toContain("Leave policy");
    expect(contextMessage?.content).not.toContain("Acme bonus");
    expect(sink.ofType("RETRIEVAL_COMPLETED")[0]?.payload).toMatchObject({ source: "handbook", resultCount: 2 });
  });

  test("search tool is scoped to the calling user's tenant", async () => {
    const tool = (await kb()).asTool({ k: 10 });
    const tools = new ToolRuntime();
    const agentIdentity = { agentId: "a", name: "a", permissions: [] };
    const acme = await tools.execute(tool, { query: "vacation bonus" }, { agent: agentIdentity, user: { userId: "u", tenantId: "acme" } });
    const other = await tools.execute(tool, { query: "vacation bonus" }, { agent: agentIdentity, user: { userId: "u", tenantId: "globex" } });
    expect(acme.output?.results.some((r) => r.citation.documentId === "acme-only")).toBe(true);
    expect(other.output?.results.some((r) => r.citation.documentId === "acme-only")).toBe(false);
  });
});
