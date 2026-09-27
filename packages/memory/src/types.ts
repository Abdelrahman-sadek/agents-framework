import type { Principal } from "@agent-framework/core";

export type MemoryKind = "conversation" | "user" | "entity" | "episodic" | "semantic";

/** Who a memory belongs to. Unset fields widen the scope (e.g. no userId = tenant-wide). */
export interface MemoryScope {
  tenantId?: string;
  userId?: string;
  agentId?: string;
  entityId?: string;
  conversationId?: string;
}

export interface MemoryProvenance {
  source: "user" | "agent" | "tool" | "system";
  runId?: string;
  createdBy?: string;
}

export interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  scope: MemoryScope;
  content: string;
  metadata: Readonly<Record<string, string | number | boolean>>;
  /** 0–1: how sure we are this is true. */
  confidence: number;
  provenance: MemoryProvenance;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  embedding?: number[];
}

/** The caller of a memory operation. Authorization is decided from this, never from content. */
export interface MemoryAccess {
  user?: Principal;
  agentId?: string;
}

export interface MemoryQuery {
  kinds?: readonly MemoryKind[];
  scope?: MemoryScope;
  includeExpired?: boolean;
}

/** Persistence port. PostgreSQL/Redis adapters implement it. */
export interface MemoryStore {
  put(record: MemoryRecord): Promise<void>;
  get(id: string): Promise<MemoryRecord | undefined>;
  list(query: MemoryQuery): Promise<MemoryRecord[]>;
  delete(id: string): Promise<boolean>;
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly records = new Map<string, MemoryRecord>();
  async put(record: MemoryRecord): Promise<void> {
    this.records.set(record.id, structuredClone(record));
  }
  async get(id: string): Promise<MemoryRecord | undefined> {
    const r = this.records.get(id);
    return r === undefined ? undefined : structuredClone(r);
  }
  async list(query: MemoryQuery): Promise<MemoryRecord[]> {
    return [...this.records.values()]
      .filter((r) => (query.kinds === undefined || query.kinds.includes(r.kind)) && scopeMatches(r.scope, query.scope))
      .map((r) => structuredClone(r));
  }
  async delete(id: string): Promise<boolean> {
    return this.records.delete(id);
  }
}

/** Every field set in `filter` must equal the record's field. */
export function scopeMatches(scope: MemoryScope, filter: MemoryScope | undefined): boolean {
  if (filter === undefined) return true;
  return (Object.keys(filter) as (keyof MemoryScope)[]).every((k) => filter[k] === undefined || scope[k] === filter[k]);
}
