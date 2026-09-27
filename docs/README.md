# Documentation

## Start here

- [Getting started](./getting-started.md)
- [Agents](./agents.md): define, run, limits, cancellation, structured output, approvals, recovery
- [Tools](./tools.md): schemas, permissions, approval, reliability, audit
- [Models and providers](./models.md): Anthropic, OpenAI-compatible and local models, gateway wrappers
- [Troubleshooting](./troubleshooting.md)

## Subsystem guides

| Guide | Package |
| --- | --- |
| [Context engine](./context.md) | `@agent-framework/context` |
| [Knowledge / RAG](./knowledge.md) | `@agent-framework/knowledge` |
| [Memory](./memory.md) | `@agent-framework/memory` |
| [Planning](./planning.md) | `@agent-framework/orchestration` |
| [Reflection and verification](./reflection.md) | `@agent-framework/core` |
| [Orchestration](./orchestration.md) | `@agent-framework/orchestration` |
| [Multi-agent systems](./multi-agent.md) | `@agent-framework/orchestration` |
| [Skills](./skills.md) | `@agent-framework/core` |
| [MCP](./mcp.md) | `@agent-framework/mcp` |
| [Sandbox tools](./sandbox.md) | `@agent-framework/sandbox` |
| [Security](./security.md) | `@agent-framework/security`, `@agent-framework/tools` |
| [Guardrails](./guardrails.md) | `@agent-framework/security` |
| [Observability](./observability.md) | `@agent-framework/observability` |
| [Evaluation](./evaluation.md) | `@agent-framework/evaluation` |
| [Production](./production.md) | `@agent-framework/production` |
| [CLI and manifests](./cli.md) | `@agent-framework/cli` |

## Architecture

| Document | Covers |
| --- | --- |
| [Overview](./architecture/README.md) | System architecture, components, lifecycles |
| [Core runtime](./architecture/core-runtime.md) | Run loop, state, ports, durability boundary |
| [Public API](./architecture/public-api.md) | Exported surface and stability levels |
| [Events](./architecture/events.md) | Event model and envelope |
| [Errors](./architecture/errors.md) | Error codes, categories, retryability |
| [Configuration](./architecture/configuration.md) | Framework / agent / run configuration layers |
| [Extension points](./architecture/extension-points.md) | Ports, decision engine, skills, sandbox, adapters |
| [Lifecycles](./architecture/lifecycles.md) | State machines |
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
- [Examples](./examples/README.md)
