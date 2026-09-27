import { KnowledgeError, type ContextItem, type ContextProvider, type EmbeddingProvider } from "@agent-farmework/core";
import { defineTool, type Tool } from "@agent-farmework/tools";
import { z } from "zod";
import { recursiveChunker, type Chunker } from "./chunking.js";
import { InMemoryVectorStore, bm25, type VectorStore } from "./stores.js";
import { tokenize } from "./embedding.js";
import { citationOf, type Chunk, type Document, type MetadataFilter, type SearchResult } from "./types.js";

export type SearchMode = "vector" | "keyword" | "hybrid";

export interface SearchOptions {
  k?: number;
  mode?: SearchMode;
  filter?: MetadataFilter;
  /** Tenant scope. Tenant documents are only returned to their tenant. */
  tenantId?: string;
  /** Drop results scoring below this (after fusion/reranking). */
  minScore?: number;
  signal?: AbortSignal;
}

/** Reorders candidates, e.g. with a cross-encoder or a reranking API. */
export interface Reranker {
  rerank(query: string, results: SearchResult[]): Promise<SearchResult[]>;
}

/** Cheap lexical reranker: fraction of query terms present in the chunk, blended with the prior score. */
export const lexicalReranker: Reranker = {
  async rerank(query, results) {
    const terms = new Set(tokenize(query));
    if (terms.size === 0) return results;
    return results
      .map((r) => {
        const tokens = new Set(tokenize(r.chunk.text));
        const overlap = [...terms].filter((t) => tokens.has(t)).length / terms.size;
        return { ...r, score: 0.5 * r.score + 0.5 * overlap };
      })
      .sort((a, b) => b.score - a.score);
  },
};

export interface KnowledgeBaseOptions {
  name: string;
  embedder: EmbeddingProvider;
  store?: VectorStore;
  chunker?: Chunker;
  reranker?: Reranker;
  /** Candidates fetched per retriever before fusion. Default 4 × k. */
  candidateMultiplier?: number;
}

export interface KnowledgeBase {
  readonly name: string;
  ingest(documents: readonly Document[], options?: { signal?: AbortSignal }): Promise<{ documents: number; chunks: number }>;
  remove(documentId: string): Promise<void>;
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  /** Contribute retrieved chunks to agent runs (scoped to the run's tenant). */
  asContextProvider(options?: Omit<SearchOptions, "tenantId" | "signal">): ContextProvider;
  /** Let the model search on demand. Results carry citations. */
  asTool(options?: { name?: string; description?: string; k?: number; permissions?: readonly string[] }): Tool<{ query: string }, { results: { citation: SearchResult["citation"]; text: string; score: number }[] }>;
}

/**
 * Documents → chunking → metadata → embeddings → vector / keyword / hybrid
 * search → reranking → results with citations.
 */
export function createKnowledgeBase(options: KnowledgeBaseOptions): KnowledgeBase {
  const store = options.store ?? new InMemoryVectorStore();
  const chunker = options.chunker ?? recursiveChunker({ maxChars: 800, overlap: 80 });
  const multiplier = options.candidateMultiplier ?? 4;

  const search = async (query: string, opts: SearchOptions = {}): Promise<SearchResult[]> => {
    const k = opts.k ?? 5;
    const mode = opts.mode ?? "hybrid";
    const scope = {
      ...(opts.filter === undefined ? {} : { filter: opts.filter }),
      ...(opts.tenantId === undefined ? {} : { tenantId: opts.tenantId }),
    };
    const candidates = k * multiplier;
    let vectorHits: { chunk: Chunk; score: number }[] = [];
    let keywordHits: { chunk: Chunk; score: number }[] = [];
    try {
      if (mode !== "keyword") {
        const [vector] = await options.embedder.embed([query], opts.signal === undefined ? {} : { signal: opts.signal });
        vectorHits = await store.query(vector ?? [], { k: candidates, ...scope });
      }
      if (mode !== "vector") keywordHits = bm25(query, await store.chunks(scope), candidates);
    } catch (cause) {
      throw new KnowledgeError(`Search in '${options.name}' failed`, { cause, retryable: true });
    }

    let fused: { chunk: Chunk; score: number }[];
    if (mode === "vector") fused = vectorHits;
    else if (mode === "keyword") {
      const top = keywordHits[0]?.score ?? 1;
      fused = keywordHits.map((h) => ({ chunk: h.chunk, score: h.score / top }));
    } else {
      // Reciprocal rank fusion, normalized so the best possible score is 1.
      const scores = new Map<string, { chunk: Chunk; score: number }>();
      for (const list of [vectorHits, keywordHits]) {
        list.forEach((hit, rank) => {
          const entry = scores.get(hit.chunk.id) ?? { chunk: hit.chunk, score: 0 };
          entry.score += 1 / (60 + rank + 1) / (2 / 61);
          scores.set(hit.chunk.id, entry);
        });
      }
      fused = [...scores.values()].sort((a, b) => b.score - a.score);
    }

    let results: SearchResult[] = fused.map((h) => ({ chunk: h.chunk, score: h.score, citation: citationOf(h.chunk) }));
    if (options.reranker !== undefined) results = await options.reranker.rerank(query, results);
    if (opts.minScore !== undefined) results = results.filter((r) => r.score >= (opts.minScore as number));
    return results.slice(0, k);
  };

  const kb: KnowledgeBase = {
    name: options.name,

    async ingest(documents, ingestOptions = {}) {
      let chunkCount = 0;
      for (const document of documents) {
        if (document.id === "" || document.text.trim() === "") throw new KnowledgeError(`Document '${document.id}' is empty or has no id`);
        const chunks = chunker.chunk(document);
        const vectors = await options.embedder.embed(
          chunks.map((c) => (c.title === undefined ? c.text : `${c.title}\n${c.text}`)),
          ingestOptions.signal === undefined ? {} : { signal: ingestOptions.signal },
        );
        await store.deleteDocument(document.id); // re-ingest replaces the previous version
        await store.upsert(chunks.map((chunk, i) => ({ chunk, vector: vectors[i] ?? [] })));
        chunkCount += chunks.length;
      }
      return { documents: documents.length, chunks: chunkCount };
    },

    remove: (documentId) => store.deleteDocument(documentId),

    search,

    asContextProvider(providerOptions = {}) {
      return {
        name: `knowledge:${options.name}`,
        async provide(request) {
          const started = Date.now();
          const results = await search(request.query, {
            ...providerOptions,
            ...(request.user?.tenantId === undefined ? {} : { tenantId: request.user.tenantId }),
            signal: request.signal,
          });
          request.emit("RETRIEVAL_COMPLETED", {
            source: options.name,
            resultCount: results.length,
            ...(results[0] === undefined ? {} : { topScore: results[0].score }),
            durationMs: Date.now() - started,
          });
          return results.map(
            (r): ContextItem => ({
              id: r.chunk.id,
              kind: "knowledge",
              content: r.chunk.text,
              score: r.score,
              source: {
                id: r.citation.documentId,
                chunkId: r.citation.chunkId,
                ...(r.citation.title === undefined ? {} : { title: r.citation.title }),
                ...(r.citation.uri === undefined ? {} : { uri: r.citation.uri }),
              },
            }),
          );
        },
      };
    },

    asTool(toolOptions = {}) {
      return defineTool({
        name: toolOptions.name ?? `search_${options.name.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 64),
        description: toolOptions.description ?? `Search the '${options.name}' knowledge base. Returns passages with citations.`,
        kind: "custom",
        permissions: toolOptions.permissions ?? [],
        input: z.object({ query: z.string().min(1).max(500).describe("What to look for") }),
        execute: async ({ query }, ctx) => {
          const results = await search(query, {
            k: toolOptions.k ?? 5,
            ...(ctx.user?.tenantId === undefined ? {} : { tenantId: ctx.user.tenantId }),
            signal: ctx.signal,
          });
          return { results: results.map((r) => ({ citation: r.citation, text: r.chunk.text, score: Number(r.score.toFixed(4)) })) };
        },
      });
    },
  };
  return kb;
}
