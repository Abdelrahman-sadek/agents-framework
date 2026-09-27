# Examples

Examples show how the framework is intended to be used. They are not toy demos; they should demonstrate realistic integration patterns.

## Available examples

| Example | Pattern | Run |
| --- | --- | --- |
| [`hello-agent`](../../examples/hello-agent) | 1. Simple agent: User → Agent → Tool → Answer | `pnpm example:hello` |
| [`research-agent`](../../examples/research-agent) | 2. Research: Plan → Search → Retrieve → Analyze → Verify → Report | `pnpm example:research` |
| [`rag-agent`](../../examples/rag-agent) | 3. RAG: retrieval → context → cited answer | `pnpm example:rag` |
| [`orchestrator`](../../examples/orchestrator) | 4. Orchestrator with research, data and verification workers | `pnpm example:orchestrator` |
| [`approval-agent`](../../examples/approval-agent) | 5. Human approval: pause → approve → resume | `pnpm example:approval` |
| [`enterprise-agent`](../../examples/enterprise-agent) | 6. Everything combined, plus evaluation | `pnpm example:enterprise` |

All examples run offline with scripted or rule-based models from `@agent-farmework/core/testing`. `pnpm examples` runs them all (CI does too). Swap in `anthropicProvider()` or `openAICompatibleProvider()` to use live models.

## Example guidelines

- Examples should show the public API shape, not internal implementation details.
- Examples should make the runtime/intelligence separation visible.
- Examples should show where deterministic controls matter.
- Examples should be kept coherent with the current Phase and updated as implementation progresses.

## Where examples live

- `examples/` for runnable examples (type-checked in CI and run by `pnpm example:*`)
- `docs/examples` for walkthroughs and conceptual explanations
