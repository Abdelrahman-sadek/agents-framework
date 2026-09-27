# Context engine

`@agent-farmework/context`

The model never receives "the whole conversation" by default. Before every model call the runtime asks a `ContextManager` which messages and context items fit:

```
Available information → relevance → priority → token budget → final model context
```

## Setup

```ts
import { createContextEngine, llmSummarizer } from "@agent-farmework/context";

const runtime = createRuntime({
  providers,
  context: createContextEngine({
    reserveOutputTokens: 2_000,     // keep room for the answer
    keepRecentTurns: 6,             // most recent turns stay verbatim
    maxToolResultTokens: 1_500,     // long tool outputs are truncated
    includeToolHistory: true,       // false: old tool results become stubs
    itemBudgetRatio: 0.3,           // share of the budget for knowledge/memory items
    minItemScore: 0.2, maxItems: 8,
    summarizer: llmSummarizer({ provider: anthropic, modelId: "claude-haiku-4-5" }),
    summarizeAfterTurns: 20,        // cost control even within budget
  }),
});
```

The budget defaults to the model's `contextWindowTokens` from `ModelCapabilities`. Set `maxTokens` to cap it lower.

## What the engine guarantees

1. The system prompt and the original task are always kept.
2. Context items (from knowledge and memory providers) are deduplicated, filtered by score, ranked by `priority` then `score`, and cut to their budget share. Each keeps its provenance (`source.id`, `chunkId`, `title`, `uri`).
3. An assistant turn with tool calls and its tool results form one atomic unit, so the model never sees a tool result without the call that produced it.
4. Older turns are summarized (summaries are cached) or dropped oldest-first.
5. If the essentials alone do not fit, a `ContextLimitError` fails the run instead of silently sending a broken prompt.
6. When anything was omitted, a `CONTEXT_ASSEMBLED` event records what and why.

## Context providers

Anything that contributes information for a run implements `ContextProvider`:

```ts
const accountContext: ContextProvider = {
  name: "account",
  async provide({ user, query, metadata, emit }) {
    const account = await accounts.get(user!.tenantId!);
    return [{ id: `account:${account.id}`, kind: "state", content: `Plan: ${account.plan}`, priority: 0.9 }];
  },
};
defineAgent({ ..., context: [handbook.asContextProvider(), memory.asContextProvider(), accountContext] });
```

Providers run once per run, after input guardrails, with the redacted input as `query`. Items are rendered inside a delimited `<context>` block labelled as data, not instructions.

A custom `ContextManager` (for example one that uses a real tokenizer or a learned compressor) can replace the engine. The run state always keeps the full transcript.
