import {
  AuthorizationError,
  ValidationError,
  cosineSimilarity,
  hasPermission,
  randomIds,
  systemClock,
  type Clock,
  type ContextItem,
  type ContextProvider,
  type EmbeddingProvider,
  type IdGenerator,
} from "@agent-farmework/core";
import { defineTool, type AnyTool } from "@agent-farmework/tools";
import { z } from "zod";
import { InMemoryMemoryStore, type MemoryAccess, type MemoryKind, type MemoryProvenance, type MemoryRecord, type MemoryScope, type MemoryStore } from "./types.js";

export interface MemoryPolicy {
  /** Kinds this memory accepts. Default: all. */
  allowedKinds?: readonly MemoryKind[];
  /** Candidates below this confidence are not stored. Default 0.6. */
  minConfidence?: number;
  /** Default time-to-live per kind. */
  ttlMs?: Partial<Record<MemoryKind, number>>;
  /** Default 2000 characters. */
  maxContentLength?: number;
  /** Content matching any pattern is rejected (default: common secret formats). */
  rejectPatterns?: readonly RegExp[];
  /** Custom rule: return a reason to reject. */
  reject?: (candidate: MemoryCandidate) => string | undefined;
}

export const DEFAULT_SECRET_PATTERNS: readonly RegExp[] = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(password|passwd|pwd|secret|api[_-]?key)\s*[:=]\s*\S+/i,
  /\b(?:\d[ -]?){13,19}\b/, // payment card-like numbers
];

export interface MemoryCandidate {
  kind: MemoryKind;
  content: string;
  scope: MemoryScope;
  confidence?: number;
  metadata?: Readonly<Record<string, string | number | boolean>>;
  ttlMs?: number;
  provenance?: MemoryProvenance;
}

export type StoreResult = { stored: true; record: MemoryRecord } | { stored: false; reason: string };

export interface MemorySearchOptions {
  kinds?: readonly MemoryKind[];
  /** Narrow within what the caller may see (e.g. an entityId). */
  scope?: MemoryScope;
  k?: number;
  minScore?: number;
}

export interface MemoryOptions {
  name?: string;
  store?: MemoryStore;
  embedder?: EmbeddingProvider;
  policy?: MemoryPolicy;
  clock?: Clock;
  ids?: IdGenerator;
}

/**
 * Policy-driven memory. Nothing is saved automatically: callers propose
 * candidates and the policy decides. Every operation is authorized against
 * the caller's identity:
 *
 * - tenant-scoped records are visible only inside their tenant;
 * - user-scoped records only to that user (or holders of `memory.admin`);
 * - agent-scoped records only to that agent.
 */
export class Memory {
  readonly name: string;
  private readonly backend: MemoryStore;
  private readonly policy: Required<Pick<MemoryPolicy, "minConfidence" | "maxContentLength" | "rejectPatterns">> & MemoryPolicy;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(private readonly options: MemoryOptions = {}) {
    this.name = options.name ?? "memory";
    this.backend = options.store ?? new InMemoryMemoryStore();
    this.policy = {
      minConfidence: 0.6,
      maxContentLength: 2000,
      rejectPatterns: DEFAULT_SECRET_PATTERNS,
      ...options.policy,
    };
    this.clock = options.clock ?? systemClock;
    this.ids = options.ids ?? randomIds;
  }

  async store(candidate: MemoryCandidate, access: MemoryAccess): Promise<StoreResult> {
    this.assertWritable(candidate.scope, access);
    const reason = this.rejectionReason(candidate);
    if (reason !== undefined) return { stored: false, reason };
    const now = this.clock.now();
    const ttl = candidate.ttlMs ?? this.policy.ttlMs?.[candidate.kind];
    const record: MemoryRecord = {
      id: this.ids.next("memory"),
      kind: candidate.kind,
      scope: candidate.scope,
      content: candidate.content.trim(),
      metadata: candidate.metadata ?? {},
      confidence: candidate.confidence ?? 1,
      provenance: candidate.provenance ?? { source: "system" },
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      ...(ttl === undefined ? {} : { expiresAt: new Date(now.getTime() + ttl).toISOString() }),
      ...(await this.embed(candidate.content)),
    };
    await this.backend.put(record);
    return { stored: true, record };
  }

  async get(id: string, access: MemoryAccess): Promise<MemoryRecord | undefined> {
    const record = await this.backend.get(id);
    if (record === undefined || this.expired(record) || !this.canRead(record, access)) return undefined;
    return record;
  }

  async search(query: string, options: MemorySearchOptions, access: MemoryAccess): Promise<{ record: MemoryRecord; score: number }[]> {
    const candidates = (await this.backend.list({ ...(options.kinds === undefined ? {} : { kinds: options.kinds }), ...(options.scope === undefined ? {} : { scope: options.scope }) }))
      .filter((r) => !this.expired(r) && this.canRead(r, access));
    const queryVector = this.options.embedder === undefined ? undefined : (await this.options.embedder.embed([query]))[0];
    const terms = new Set(words(query));
    return candidates
      .map((record) => {
        const similarity =
          queryVector !== undefined && record.embedding !== undefined
            ? cosineSimilarity(queryVector, record.embedding)
            : terms.size === 0
              ? 0
              : words(record.content).filter((w) => terms.has(w)).length / terms.size;
        return { record, score: similarity * (0.5 + 0.5 * record.confidence) };
      })
      .filter((r) => r.score > (options.minScore ?? 0))
      .sort((a, b) => b.score - a.score)
      .slice(0, options.k ?? 5);
  }

  async update(id: string, patch: Partial<Pick<MemoryRecord, "content" | "confidence" | "metadata">>, access: MemoryAccess): Promise<MemoryRecord> {
    const record = await this.backend.get(id);
    if (record === undefined || !this.canRead(record, access)) throw new ValidationError(`Memory '${id}' not found`);
    this.assertWritable(record.scope, access);
    const next: MemoryRecord = { ...record, ...patch, updatedAt: this.clock.now().toISOString() };
    if (patch.content !== undefined) {
      const reason = this.rejectionReason({ kind: record.kind, content: patch.content, scope: record.scope, confidence: next.confidence });
      if (reason !== undefined) throw new ValidationError(`Memory update rejected: ${reason}`);
      Object.assign(next, await this.embed(patch.content));
    }
    await this.backend.put(next);
    return next;
  }

  async delete(id: string, access: MemoryAccess): Promise<boolean> {
    const record = await this.backend.get(id);
    if (record === undefined || !this.canRead(record, access)) return false;
    this.assertWritable(record.scope, access);
    return this.backend.delete(id);
  }

  /** Right to be forgotten: delete everything in a scope the caller controls. Returns the count. */
  async forget(scope: MemoryScope, access: MemoryAccess): Promise<number> {
    this.assertWritable(scope, access);
    let count = 0;
    for (const record of await this.backend.list({ scope, includeExpired: true })) {
      if (this.canRead(record, access) && (await this.backend.delete(record.id))) count++;
    }
    return count;
  }

  /** Lifecycle management: physically remove expired records. */
  async purgeExpired(): Promise<number> {
    let count = 0;
    for (const record of await this.backend.list({ includeExpired: true })) {
      if (this.expired(record) && (await this.backend.delete(record.id))) count++;
    }
    return count;
  }

  /** Record an important event (episodic memory) for the user and agent. */
  recordEpisode(episode: { summary: string; runId: string; outcome?: string; confidence?: number }, access: MemoryAccess): Promise<StoreResult> {
    return this.store(
      {
        kind: "episodic",
        content: episode.outcome === undefined ? episode.summary : `${episode.summary} (outcome: ${episode.outcome})`,
        scope: this.ownScope(access),
        confidence: episode.confidence ?? 1,
        provenance: { source: "agent", runId: episode.runId, ...(access.agentId === undefined ? {} : { createdBy: access.agentId }) },
      },
      access,
    );
  }

  /** Recall relevant memories for the run's user and agent. */
  asContextProvider(options: MemorySearchOptions = {}): ContextProvider {
    return {
      name: `memory:${this.name}`,
      provide: async (request) => {
        const access = { ...(request.user === undefined ? {} : { user: request.user }), agentId: request.agentId };
        const conversationId = typeof request.metadata["conversationId"] === "string" ? request.metadata["conversationId"] : undefined;
        const results = await this.search(request.query, { k: 5, ...options }, access);
        const conversation =
          conversationId === undefined
            ? []
            : (await this.backend.list({ kinds: ["conversation"], scope: { conversationId } }))
                .filter((r) => !this.expired(r) && this.canRead(r, access))
                .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
                .map((record) => ({ record, score: 1 }));
        const all = [...conversation, ...results.filter((r) => r.record.kind !== "conversation")];
        request.emit("MEMORY_READ", { store: this.name, resultCount: all.length });
        return all.map(
          ({ record, score }): ContextItem => ({
            id: record.id,
            kind: "memory",
            content: `(${record.kind}, confidence ${record.confidence.toFixed(2)}) ${record.content}`,
            score,
            priority: record.kind === "conversation" ? 0.8 : 0.6,
            source: { id: record.id, title: `${record.kind} memory` },
          }),
        );
      },
    };
  }

  /** Append conversation turns so later runs with the same conversationId can recall them. */
  async appendConversation(conversationId: string, turns: readonly { role: "user" | "assistant"; content: string }[], access: MemoryAccess): Promise<void> {
    for (const turn of turns) {
      await this.store(
        { kind: "conversation", content: `${turn.role}: ${turn.content}`, scope: { ...this.ownScope(access), conversationId }, confidence: 1, provenance: { source: turn.role === "user" ? "user" : "agent" } },
        access,
      );
    }
  }

  /** `remember` and `recall` tools. Writes still pass the memory policy and are scoped to the calling user. */
  asTools(options: { permissions?: readonly string[] } = {}): AnyTool[] {
    const remember = defineTool({
      name: "remember",
      description: "Save a durable fact or preference about the current user for future conversations. Only save stable, useful information.",
      permissions: options.permissions ?? [],
      input: z.object({
        content: z.string().min(3).max(500),
        kind: z.enum(["user", "semantic", "entity"]).default("user"),
        entityId: z.string().optional(),
        confidence: z.number().min(0).max(1).default(0.8),
      }),
      execute: async (input, ctx) => {
        const access = { ...(ctx.user === undefined ? {} : { user: ctx.user }), agentId: ctx.agentId };
        const result = await this.store(
          {
            kind: input.kind,
            content: input.content,
            confidence: input.confidence,
            scope: { ...this.ownScope(access), ...(input.entityId === undefined ? {} : { entityId: input.entityId }) },
            provenance: { source: "agent", runId: ctx.runId, createdBy: ctx.agentId },
          },
          access,
        );
        return result.stored ? { stored: true, id: result.record.id } : { stored: false, reason: result.reason };
      },
    });
    const recall = defineTool({
      name: "recall",
      description: "Search saved memories about the current user.",
      permissions: options.permissions ?? [],
      input: z.object({ query: z.string().min(1) }),
      execute: async ({ query }, ctx) => {
        const results = await this.search(query, { k: 5 }, { ...(ctx.user === undefined ? {} : { user: ctx.user }), agentId: ctx.agentId });
        return results.map((r) => ({ id: r.record.id, kind: r.record.kind, content: r.record.content, confidence: r.record.confidence }));
      },
    });
    return [remember, recall];
  }

  // ------------------------------------------------------------------ internals

  private ownScope(access: MemoryAccess): MemoryScope {
    return {
      ...(access.user?.tenantId === undefined ? {} : { tenantId: access.user.tenantId }),
      ...(access.user === undefined ? {} : { userId: access.user.userId }),
    };
  }

  private isAdmin(access: MemoryAccess): boolean {
    return hasPermission(access.user?.permissions, "memory.admin");
  }

  private canRead(record: MemoryRecord, access: MemoryAccess): boolean {
    const { scope } = record;
    if (scope.tenantId !== undefined && scope.tenantId !== access.user?.tenantId) return false;
    if (scope.agentId !== undefined && scope.agentId !== access.agentId) return false;
    if (scope.userId !== undefined && scope.userId !== access.user?.userId && !this.isAdmin(access)) return false;
    return true;
  }

  private assertWritable(scope: MemoryScope, access: MemoryAccess): void {
    if (scope.tenantId !== undefined && scope.tenantId !== access.user?.tenantId) {
      throw new AuthorizationError("Cannot write memory for another tenant");
    }
    if (scope.userId !== undefined && scope.userId !== access.user?.userId && !this.isAdmin(access)) {
      throw new AuthorizationError("Cannot write memory for another user");
    }
    if (scope.agentId !== undefined && scope.agentId !== access.agentId) {
      throw new AuthorizationError("Cannot write memory for another agent");
    }
    if (scope.tenantId === undefined && scope.userId === undefined && !this.isAdmin(access)) {
      throw new AuthorizationError("Global memory requires memory.admin");
    }
  }

  private rejectionReason(candidate: MemoryCandidate): string | undefined {
    const p = this.policy;
    if (p.allowedKinds !== undefined && !p.allowedKinds.includes(candidate.kind)) return `kind '${candidate.kind}' not allowed`;
    const content = candidate.content.trim();
    if (content.length === 0) return "empty content";
    if (content.length > p.maxContentLength) return "content too long";
    if ((candidate.confidence ?? 1) < p.minConfidence) return `confidence below ${p.minConfidence}`;
    if (p.rejectPatterns.some((re) => re.test(content))) return "content looks like a secret or sensitive identifier";
    return p.reject?.(candidate);
  }

  private expired(record: MemoryRecord): boolean {
    return record.expiresAt !== undefined && Date.parse(record.expiresAt) <= this.clock.now().getTime();
  }

  private async embed(content: string): Promise<{ embedding?: number[] }> {
    if (this.options.embedder === undefined) return {};
    const [embedding] = await this.options.embedder.embed([content]);
    return embedding === undefined ? {} : { embedding };
  }
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
}

export function createMemory(options: MemoryOptions = {}): Memory {
  return new Memory(options);
}
