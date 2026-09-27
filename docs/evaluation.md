# Evaluation

`@agent-framework/evaluation`

```ts
const evaluation = defineEvaluation({
  name: "support-regression",
  dataset: defineDataset("support-golden", [
    { id: "refund-small", input: "Refund ord-17", expected: "on its way", expectedTools: ["lookup_order"] },
    { id: "vacation", input: "How many vacation days?", expected: ["25"], relevantDocuments: ["leave-policy"] },
  ]),
  target: agent,                                   // or async (case, signal) => ({ output, ... })
  evaluators: [
    evaluators.status(),
    evaluators.contains(),                         // correctness vs. expected
    evaluators.toolUsage(),                        // expected tools called, forbidden tools not
    evaluators.retrievalRecall({ k: 3 }),          // RAG: relevant docs retrieved
    evaluators.groundedness({ threshold: 0.8 }),   // answer supported by context
    evaluators.safety([piiGuardrail()]),           // no PII / policy violations in output
    evaluators.cost(0.05), evaluators.latency(10_000),
    evaluators.llmJudge({ provider, modelId: "claude-opus-5", rubric: "Polite, correct, cites policy." }),
  ],
  concurrency: 4,
  thresholds: { minPassRate: 0.95, minMeanScore: { groundedness: 0.9 }, maxTotalCostUsd: 2 },
});

const report = await evaluation.run();
console.log(formatReport(report));                 // markdown table
report.passed;                                     // thresholds met
compareReports(baseline, report).regressions;      // regression testing
```

Every evaluator returns `{ score: 0–1, passed, reason }`. An evaluator that throws counts as a failed score. For agent targets, observations include status, output, cost, tokens, latency, tool calls, retrieved documents and the context texts the model actually saw.

## In CI

```bash
agent evaluate agents/support/eval.ts --baseline eval-baseline.json --out eval-report.json
```

The command exits non-zero when thresholds fail or scores regress against the baseline. Keep golden datasets in the repository, and use scripted or rule-based providers for fast deterministic suites next to a smaller live-model suite.
