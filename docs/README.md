# Documentation

## Guides

| Guide | Status |
| --- | --- |
| [Getting started](./getting-started.md) | ✅ |
| [Agents](./agents.md): define, run, limits, cancellation, structured output, approvals | ✅ |
| [Tools](./tools.md): schemas, permissions, approval, reliability, audit, adapters | ✅ |
| [Troubleshooting](./troubleshooting.md) | ✅ |

## Architecture

| Document | Covers |
| --- | --- |
| [Overview](./architecture/README.md) | System architecture, components, lifecycles |
| [Core runtime](./architecture/core-runtime.md) | Run loop, state, ports, durability boundary |
| [Public API](./architecture/public-api.md) | Exported surface and stability levels |
| [Events](./architecture/events.md) | Event model and envelope |
| [Errors](./architecture/errors.md) | Error codes, categories, retryability |
| [Configuration](./architecture/configuration.md) | Framework / agent / run configuration layers |
| [Extension points](./architecture/extension-points.md) | Decision engine, context, skills, sandbox, adapters |
| [Lifecycles](./architecture/lifecycles.md) | State machines for runs, tools, approvals, and later phases |
| [Data flow](./architecture/data-flow.md) | How data moves through a run |
| [Data model](./data-model/README.md) | Entities and persisted state |
| [Concepts](./concepts/README.md) | Glossary |

## Security

- [Security model and controls](./security/README.md)
- [Threat model](./security/threat-model.md)

## Decisions

- [Architectural Decision Records](./decisions/README.md)
- [Open questions and risks](./decisions/open-questions.md)
- [Roadmap](./roadmap.md)

## Subsystems by phase

The subsystem guides below are written when their phase ships. Until then, the architecture overview describes the intended design.

| Topic | Phase | Design today |
| --- | --- | --- |
| Structured outputs | 3 | [Agents › Structured output](./agents.md#structured-output) |
| Context engine | 4 | [Architecture §4.3](./architecture/README.md#43-context-engine), [`ContextManager` port](./architecture/extension-points.md#context-manager) |
| Knowledge / RAG | 5 | [Architecture §4.5](./architecture/README.md#45-knowledge--rag) |
| Memory | 6 | [Architecture §4.4](./architecture/README.md#44-memory) |
| Planning | 7 | [Architecture §4.6](./architecture/README.md#46-planning) |
| Reflection | 8 | [Architecture §4.7](./architecture/README.md#47-reflection--verification) |
| Orchestration / multi-agent | 9–10 | [Architecture §4.8](./architecture/README.md#48-orchestration) |
| Guardrails / security | 11 | [Security](./security/README.md) |
| Observability | 12 | [Events](./architecture/events.md), [ADR 007](./decisions/007-opentelemetry.md) |
| Evaluation | 13 | [Roadmap](./roadmap.md#phase-13--evaluation) |
| Production | 14 | [Core runtime › Durability](./architecture/core-runtime.md#durability-boundary), [ADR 013](./decisions/013-temporal-durable-execution.md) |
