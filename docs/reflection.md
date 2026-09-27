# Reflection and verification

`Generate → Verify → Correct`, in `@agent-farmework/core`.

Reflection is opt-in because each correction costs a model call. It is bounded by `limits.maxReflectionAttempts` (default 1).

```ts
defineAgent({
  ...,
  output: ReportSchema,                         // schema validation with correction (Phase 3)
  reflection: {
    verifiers: [
      citationVerifier({ minCitations: 1 }),    // source verification
      ruleVerifier("no-guarantees", ({ text }) => (/guarantee/i.test(text) ? "Do not promise guarantees." : true)),
      llmCritic({ provider: anthropic, modelId: "claude-opus-5", rubric: "Every claim is supported by the sources." }),
      agentVerifier(reviewerAgent),             // cross-agent verification (@agent-farmework/orchestration)
    ],
  },
  limits: { maxOutputCorrections: 1, maxReflectionAttempts: 2 },
});
```

## How it runs

1. The model produces a final answer.
2. Output guardrails run, then the `output` schema is checked. On failure the model gets the validation error (`OUTPUT_VALIDATION_FAILED`) and tries again, up to `maxOutputCorrections`.
3. Every verifier runs (`VERIFICATION_COMPLETED`). Failures are sent back as concrete feedback (`VERIFICATION_FAILED`, `willRetry`) up to `maxReflectionAttempts`. After that the run fails with `VERIFICATION_FAILED` and the feedback in `error.metadata.failures`.
4. A verifier that throws counts as a failure.

## Choosing verifiers

| Strategy | Verifier | Cost |
| --- | --- | --- |
| Schema validation | `output` schema | free |
| Rules / deterministic checks | `ruleVerifier` | free |
| Source verification | `citationVerifier` | free |
| Tool-based verification | `ruleVerifier` calling a tool or service | varies |
| LLM critic | `llmCritic` (use a different model or prompt from the generator) | one model call |
| Cross-agent | `agentVerifier` | one agent run |

"Fake reflection", where the same model says it is correct without evidence, is an anti-pattern. Critics always receive the sources and a rubric.

Orchestrators accept `verifiers` too, and check the aggregated result.
