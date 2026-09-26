# Examples

Examples show how the framework is intended to be used. They are not toy demos; they should demonstrate realistic integration patterns.

## Planned examples

- **Simple agent:** user input, one agent, one or a few tools, final answer
- **Research agent:** planning, search, retrieval, analysis, verification, report
- **RAG agent:** question, knowledge retrieval, context, cited answer
- **Orchestrated agent:** orchestrator with multiple workers and aggregation
- **Human approval:** proposed action, approval pause, execution after consent
- **Enterprise agent:** a complete realistic example combining planning, tools, RAG, memory, workers, reflection, guardrails, observability, and evaluation

## Example guidelines

- Examples should show the public API shape, not internal implementation details.
- Examples should make the runtime/intelligence separation visible.
- Examples should show where deterministic controls matter.
- Examples should be kept coherent with the current Phase and updated as implementation progresses.

## Where examples live

- `apps/examples` for runnable examples
- `docs/examples` for walkthroughs and conceptual explanations
