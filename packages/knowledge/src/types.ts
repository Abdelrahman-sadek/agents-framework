export type MetadataValue = string | number | boolean;
export type Metadata = Readonly<Record<string, MetadataValue>>;

export interface Document {
  id: string;
  text: string;
  title?: string;
  uri?: string;
  metadata?: Metadata;
  /** Owning tenant. Documents without a tenant are global (visible to every tenant). */
  tenantId?: string;
}

export interface Chunk {
  id: string;
  documentId: string;
  index: number;
  text: string;
  title?: string;
  uri?: string;
  metadata: Metadata;
  tenantId?: string;
}

export interface Citation {
  documentId: string;
  chunkId: string;
  title?: string;
  uri?: string;
}

export interface SearchResult {
  chunk: Chunk;
  score: number;
  citation: Citation;
}

/** Equality per key; an array means "any of". All keys must match. */
export type MetadataFilter = Readonly<Record<string, MetadataValue | readonly MetadataValue[]>>;

export function matchesFilter(metadata: Metadata, filter: MetadataFilter | undefined): boolean {
  if (filter === undefined) return true;
  return Object.entries(filter).every(([key, expected]) => {
    const actual = metadata[key];
    return Array.isArray(expected) ? (expected as readonly MetadataValue[]).includes(actual as MetadataValue) : actual === expected;
  });
}

export function citationOf(chunk: Chunk): Citation {
  return {
    documentId: chunk.documentId,
    chunkId: chunk.id,
    ...(chunk.title === undefined ? {} : { title: chunk.title }),
    ...(chunk.uri === undefined ? {} : { uri: chunk.uri }),
  };
}
