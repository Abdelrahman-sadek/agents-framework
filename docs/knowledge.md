# Knowledge / RAG

`@agent-farmework/knowledge`

```
Documents → parsing → chunking → metadata → embeddings → vector / keyword / hybrid search → reranking → context with citations
```

## Create and ingest

```ts
import { createKnowledgeBase, hashingEmbedder, recursiveChunker, htmlToText } from "@agent-farmework/knowledge";

const kb = createKnowledgeBase({
  name: "handbook",
  embedder: hashingEmbedder(),          // dev default; use a neural EmbeddingProvider in production
  chunker: recursiveChunker({ maxChars: 800, overlap: 80 }),
  // store: pgvectorStore(...)          // any VectorStore adapter
  // reranker: myCrossEncoder,
});

await kb.ingest([
  { id: "leave", title: "Leave policy", uri: "https://intranet/leave", text: "...", metadata: { dept: "hr" } },
  { id: "acme-bonus", text: htmlToText(html), tenantId: "acme" },   // tenant-private document
]);
```

Re-ingesting a document id replaces its chunks. `kb.remove(id)` deletes them.

## Search

```ts
const results = await kb.search("vacation carry over", {
  k: 5,
  mode: "hybrid",                        // "vector" | "keyword" | "hybrid" (reciprocal rank fusion)
  filter: { dept: ["hr", "legal"] },     // metadata equality / any-of
  tenantId: user.tenantId,               // tenant chunks only for their tenant
  minScore: 0.2,                         // avoid "blind RAG"
});
results[0].citation; // { documentId, chunkId, title, uri }
```

## Use in agents

- **Automatic retrieval:** `context: [kb.asContextProvider({ k: 3, minScore: 0.2 })]`. Results are scoped to the run's tenant and emit `RETRIEVAL_COMPLETED`.
- **On demand:** `tools: [kb.asTool({ k: 5 })]`. The model searches when it decides to, and results carry citations.
- **Verified citations:** `reflection: { verifiers: [citationVerifier()] }` rejects answers that cite nothing or cite unknown sources.

## Ports

| Port | In-memory implementation | Production |
| --- | --- | --- |
| `EmbeddingProvider` (core) | `hashingEmbedder()` (deterministic, local, free) | hosted or local neural embedders ([ADR 015](./decisions/015-local-embedding-strategy.md)) |
| `VectorStore` | `InMemoryVectorStore` | pgvector ([ADR 006](./decisions/006-pgvector-reference-store.md)), Qdrant, OpenSearch… |
| `Reranker` | `lexicalReranker` | cross-encoders, rerank APIs |

Treat retrieved documents as untrusted: combine RAG with `promptInjectionGuardrail` on tool results ([Guardrails](./guardrails.md)).
