# Memory

`@agent-farmework/memory`

Memory is separate from knowledge. Knowledge is curated content. Memory is what an agent learns about users, entities and past events.

| Kind | Use |
| --- | --- |
| `conversation` | Turns of a conversation, recalled by `metadata.conversationId` |
| `user` | Stable preferences and facts about a user |
| `entity` | Facts about organizations, projects, customers (`scope.entityId`) |
| `episodic` | Important past events (`recordEpisode`) |
| `semantic` | Reusable extracted knowledge |

Short-term memory is the run state itself.

## Policy first: nothing is saved automatically

```ts
const memory = createMemory({
  embedder: hashingEmbedder(),
  policy: {
    allowedKinds: ["user", "episodic", "conversation"],
    minConfidence: 0.7,
    ttlMs: { conversation: 7 * 86_400_000, episodic: 90 * 86_400_000 },
    maxContentLength: 1_000,
    reject: (c) => (c.content.match(/diagnos/i) ? "health data is not stored" : undefined),
  },
});
```

By default, content that looks like a secret or card number is rejected. Every record carries `scope`, `confidence`, `provenance` (`source`, `runId`, `createdBy`), `createdAt` / `updatedAt` / `expiresAt` and `metadata`.

## Operations and authorization

```ts
const access = { user, agentId: "assistant" };
await memory.store({ kind: "user", content: "Prefers email", scope: { tenantId: user.tenantId, userId: user.userId }, confidence: 0.9 }, access);
await memory.search("contact preference", { kinds: ["user"], k: 5 }, access);
await memory.get(id, access); await memory.update(id, { confidence: 1 }, access); await memory.delete(id, access);
await memory.forget({ tenantId, userId }, access);    // right to be forgotten
await memory.purgeExpired();                          // lifecycle
```

Every operation is authorized from the caller's identity, never from content:

- tenant-scoped records are visible only inside that tenant;
- user-scoped records only to that user (or holders of `memory.admin`);
- agent-scoped records only to that agent;
- global memory requires `memory.admin`.

## In agents

- `context: [memory.asContextProvider({ k: 5 })]` recalls memories plus conversation history for `run({ metadata: { conversationId } })`.
- `tools: memory.asTools()` adds `remember` and `recall` tools. Writes still go through the policy and are scoped to the calling user.
- `memory.appendConversation(conversationId, turns, access)` and `memory.recordEpisode({ summary, runId }, access)` let application code decide what to persist.

`MemoryStore` is the persistence port (in-memory included; PostgreSQL/Redis adapters implement the same interface).
