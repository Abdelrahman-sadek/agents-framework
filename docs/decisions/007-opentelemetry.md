# ADR 007: OpenTelemetry for observability

**Status:** Accepted

**Context**

Agent execution must be observable across LLM calls, tool calls, retrieval, memory operations, workers, reflection, and final output. Building a proprietary tracing system would create lock-in and duplicate effort. The framework should instead rely on a widely supported observability standard.

**Decision**

Use OpenTelemetry from day one.

- Traces and spans for execution
- Metrics where appropriate
- Logs where appropriate
- Correlation ids, run ids, agent ids, and tool/LLM/retrieval identifiers
- Configurable redaction policies

**Default behavior**

Development defaults to console/export-friendly observability with controlled local output. Production defaults to exporting to OTLP and an observability backend through a collector or compatible platform.

**Design rules**

- Do not log sensitive data blindly.
- Prompts, tool arguments, documents, and user data are not assumed safe for telemetry.
- Redaction is configurable and must be considered mandatory for production.

**Alternatives considered**

- Custom tracing/telemetry format
- Logging only, with no structured tracing
- Proprietary observability SDK embedded in the framework

**Consequences**

- Observability is interoperable with the broader ecosystem.
- The framework can report cost, latency, errors, token usage, and execution structure in a consistent way.
- Redaction and privacy require explicit design and ongoing discipline.
- Semantic conventions must be chosen carefully to keep telemetry useful without exposing sensitive content.
