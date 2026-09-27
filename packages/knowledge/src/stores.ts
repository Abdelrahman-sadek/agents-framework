import { cosineSimilarity } from "@agent-framework/core";
import { matchesFilter, type Chunk, type MetadataFilter } from "./types.js";
import { tokenize } from "./embedding.js";

export interface VectorRecord {
  chunk: Chunk;
  vector: number[];
}

export interface VectorQuery {
  k: number;
  filter?: MetadataFilter;
  /** Tenant scope; see `tenantVisible`. */
  tenantId?: string;
}

/** Vector store port. pgvector, Qdrant, OpenSearch… are adapters. */
export interface VectorStore {
  upsert(records: readonly VectorRecord[]): Promise<void>;
  deleteDocument(documentId: string): Promise<void>;
  query(vector: readonly number[], query: VectorQuery): Promise<{ chunk: Chunk; score: number }[]>;
  /** All chunks visible under the scope (used by keyword search in small stores). */
  chunks(query: Omit<VectorQuery, "k">): Promise<Chunk[]>;
}

/** Tenant chunks are visible only to that tenant; global chunks to everyone. */
export function tenantVisible(chunk: Chunk, tenantId: string | undefined): boolean {
  return chunk.tenantId === undefined || chunk.tenantId === tenantId;
}

export class InMemoryVectorStore implements VectorStore {
  private readonly records = new Map<string, VectorRecord>();

  async upsert(records: readonly VectorRecord[]): Promise<void> {
    for (const r of records) this.records.set(r.chunk.id, r);
  }

  async deleteDocument(documentId: string): Promise<void> {
    for (const [id, r] of this.records) if (r.chunk.documentId === documentId) this.records.delete(id);
  }

  async query(vector: readonly number[], query: VectorQuery): Promise<{ chunk: Chunk; score: number }[]> {
    return [...this.records.values()]
      .filter((r) => tenantVisible(r.chunk, query.tenantId) && matchesFilter(r.chunk.metadata, query.filter))
      .map((r) => ({ chunk: r.chunk, score: cosineSimilarity(vector, r.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, query.k);
  }

  async chunks(query: Omit<VectorQuery, "k">): Promise<Chunk[]> {
    return [...this.records.values()]
      .map((r) => r.chunk)
      .filter((c) => tenantVisible(c, query.tenantId) && matchesFilter(c.metadata, query.filter));
  }
}

/** Okapi BM25 over a set of chunks. */
export function bm25(query: string, chunks: readonly Chunk[], k: number, options: { k1?: number; b?: number } = {}): { chunk: Chunk; score: number }[] {
  const k1 = options.k1 ?? 1.2;
  const b = options.b ?? 0.75;
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0 || chunks.length === 0) return [];
  const docs = chunks.map((chunk) => ({ chunk, tokens: tokenize(chunk.text) }));
  const avgLen = docs.reduce((s, d) => s + d.tokens.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const term of terms) df.set(term, docs.filter((d) => d.tokens.includes(term)).length);
  return docs
    .map(({ chunk, tokens }) => {
      let score = 0;
      for (const term of terms) {
        const tf = tokens.filter((t) => t === term).length;
        if (tf === 0) continue;
        const n = df.get(term) ?? 0;
        const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
        score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * tokens.length) / avgLen)));
      }
      return { chunk, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, k);
}
