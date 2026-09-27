/**
 * @agent-framework/knowledge — provider-independent knowledge / RAG.
 */
export { createKnowledgeBase, lexicalReranker } from "./knowledge-base.js";
export type { KnowledgeBase, KnowledgeBaseOptions, Reranker, SearchMode, SearchOptions } from "./knowledge-base.js";
export { fixedSizeChunker, htmlToText, recursiveChunker } from "./chunking.js";
export type { Chunker } from "./chunking.js";
export { hashingEmbedder, tokenize } from "./embedding.js";
export { InMemoryVectorStore, bm25, tenantVisible } from "./stores.js";
export type { VectorQuery, VectorRecord, VectorStore } from "./stores.js";
export { citationOf, matchesFilter } from "./types.js";
export type { Chunk, Citation, Document, Metadata, MetadataFilter, MetadataValue, SearchResult } from "./types.js";
