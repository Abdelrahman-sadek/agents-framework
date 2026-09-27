/**
 * @agent-farmework/memory — memory separate from knowledge.
 */
export { DEFAULT_SECRET_PATTERNS, Memory, createMemory } from "./memory.js";
export type { MemoryCandidate, MemoryOptions, MemoryPolicy, MemorySearchOptions, StoreResult } from "./memory.js";
export { InMemoryMemoryStore, scopeMatches } from "./types.js";
export type { MemoryAccess, MemoryKind, MemoryProvenance, MemoryQuery, MemoryRecord, MemoryScope, MemoryStore } from "./types.js";
