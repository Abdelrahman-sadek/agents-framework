# Examples

Examples show how the framework is intended to be used. They are not toy demos; they should demonstrate realistic integration patterns.

## Available examples

| Example | Pattern | Run |
| --- | --- | --- |
| [`examples/hello-agent`](../../examples/hello-agent) | Simple agent: User → Agent → Tool → Answer | `pnpm example:hello` |
| [`examples/approval-agent`](../../examples/approval-agent) | Human approval: proposed action → pause → approve → resume | `pnpm example:approval` |

Both run offline with the scripted provider from `@agent-framework/core/testing`.

## Planned examples

- **Research agent:** planning, search, retrieval, analysis, verification, report
- **RAG agent:** question, knowledge retrieval, context, cited answer
- **Orchestrated agent:** orchestrator with multiple workers and aggregation
- **Enterprise agent:** a complete realistic example combining planning, tools, RAG, memory, workers, reflection, guardrails, observability, and evaluation

## Example guidelines

- Examples should show the public API shape, not internal implementation details.
- Examples should make the runtime/intelligence separation visible.
- Examples should show where deterministic controls matter.
- Examples should be kept coherent with the current Phase and updated as implementation progresses.

## Where examples live

- `examples/` for runnable examples (type-checked in CI and run by `pnpm example:*`)
- `docs/examples` for walkthroughs and conceptual explanations
