# Roadmap

The framework was built one phase at a time. Every phase ships with typecheck, lint, unit, integration and security tests, documentation and an example.

| Phase | Scope | Status | Where |
| --- | --- | --- | --- |
| 0 | Architecture, ADRs, threat model, data model, API proposal | ✅ | [architecture](./architecture/README.md), [decisions](./decisions/README.md) |
| 1 | Core runtime: agents, run loop, state, events, errors, LLM contract, limits, cancellation | ✅ | [agents](./agents.md), [core runtime](./architecture/core-runtime.md) |
| 2 | Tool system: schemas, deterministic authorization, approval, timeout, retry, rate limit, idempotency, audit | ✅ | [tools](./tools.md), [ADR 018](./decisions/018-tool-system.md) |
| 3 | Structured outputs: JSON Schema response format, validation, correction loop | ✅ | [agents › structured output](./agents.md#structured-output) |
| 4 | Context engine: budgets, ranked items, truncation, atomic tool turns, summarization | ✅ | [context](./context.md) |
| 5 | Knowledge / RAG: chunking, embeddings, vector/keyword/hybrid search, reranking, citations, tenant scoping | ✅ | [knowledge](./knowledge.md) |
| 6 | Memory: five kinds, policies, scope and ownership, TTL, provenance, forget | ✅ | [memory](./memory.md) |
| 7 | Planning: validated DAG plans, static and model planners, re-planning | ✅ | [planning](./planning.md) |
| 8 | Reflection: rule, citation, LLM-critic and cross-agent verifiers with bounded correction | ✅ | [reflection](./reflection.md) |
| 9 | Orchestration: workers, bounded parallelism, retries, timeouts, failure policies, aggregation | ✅ | [orchestration](./orchestration.md) |
| 10 | Multi-agent: delegation with depth limits, supervisor, pipeline, parallel | ✅ | [multi-agent](./multi-agent.md) |
| 11 | Security: guardrails, RBAC/ABAC, tenant isolation, data classification, SSRF-safe egress, secrets, identity | ✅ | [security](./security.md), [guardrails](./guardrails.md) |
| 12 | Observability: OpenTelemetry bridge, metrics, logs, redaction, cost tracking, run inspection | ✅ | [observability](./observability.md) |
| 13 | Evaluation: datasets, deterministic and judge evaluators, thresholds, regression comparison | ✅ | [evaluation](./evaluation.md) |
| 14 | Production: durable state (PostgreSQL, SQLite), queues, workers, recovery, service API, health, config validation | ✅ | [production](./production.md), [ADR 019](./decisions/019-production-runtime.md) |
| — | Provider adapters and model gateway | ✅ | [models](./models.md), [ADR 020](./decisions/020-provider-adapters.md) |
| — | CLI and agent manifests | ✅ | [cli](./cli.md), [ADR 021](./decisions/021-manifest-and-cli.md) |

### Post-plan additions

| Item | Status | Where |
| --- | --- | --- |
| Streaming through the run loop and adapters | ✅ | [agents › streaming](./agents.md#streaming) |
| Approval modify / escalate | ✅ | [agents › human approval](./agents.md#human-approval) |
| Skills | ✅ | [skills](./skills.md) |
| Model router | ✅ | [models › router](./models.md#model-router) |
| pgvector, PostgreSQL memory, Redis rate-limit / idempotency stores | ✅ | [production › shared stores](./production.md#shared-stores) |
| MCP adapter | ✅ | [mcp](./mcp.md) |
| Sandbox tools | ✅ | [sandbox](./sandbox.md) |
| Run dashboard | ✅ | [observability › dashboard](./observability.md#dashboard) |
| Release workflow | ✅ | `.github/workflows/release.yml` |

## Next

- **Publish 0.x:** choose the npm scope ([ADR 014](./decisions/014-package-identity.md)), add the `NPM_TOKEN` secret and push a `v0.1.0` tag.
- **Container `SandboxRunner`:** Docker or microVM runner with no network, a read-only root and quotas.
- **Temporal worker:** Temporal activities that call `run`, `resume` and `recover` ([ADR 013](./decisions/013-temporal-durable-execution.md)).
- **Native Gemini adapter:** Gemini already works through its OpenAI-compatible endpoint.
- **Dashboard auth and live approvals:** approve or reject from the UI through `AgentService`.

## Cross-cutting rules

- Every phase passes TypeScript, lint, tests, a security review, documentation and an example before merging.
- Public contracts change only with an ADR.
- The runtime remains deterministic; models never authorize, budget or persist.
