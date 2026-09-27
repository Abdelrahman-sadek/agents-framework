# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Until 1.0, minor versions may contain breaking changes.

## [Unreleased]

### Added — post-plan

- Streaming: `agent.stream()`, `onTextDelta` / `onEvent`; streaming in the Anthropic and OpenAI-compatible adapters.
- Approvals: `modified` (reviewer-supplied arguments, re-validated) and `escalated` decisions; `TOOL_APPROVAL_ESCALATED`.
- Skills: `defineSkill` with dependencies, merged idempotently by `defineAgent`; `skillDataset` for evaluation.
- `createModelRouter` with requirement filters and cheapest/fastest/best/local-first strategies.
- Production stores: `PgVectorStore`, `PostgresMemoryStore`, `RedisRateLimiter`, `RedisIdempotencyStore`.
- `@agent-framework/mcp` (MCP servers as framework tools) and `@agent-framework/sandbox` (workspace-confined files, allow-listed commands).
- Dashboard: `createDashboardServer` and `agent dashboard`.
- Release workflow publishing to GitHub Packages (`@agent-framework/*`), manual or on `v*` tags; install instructions.

### Fixed

- An escalation without `escalateTo` is rejected by `resume()` instead of failing the run.

### Added — Phases 3–14

- **Structured outputs (3):** JSON Schema `responseFormat` derived from the output schema; correction loop bounded by `maxOutputCorrections`.
- **Context (4):** `@agent-framework/context` engine: token budgets, ranked context items with provenance, tool-result truncation, atomic tool turns, cached summarization, `ContextLimitError`.
- **Knowledge (5):** `@agent-framework/knowledge`: chunkers, local hashing embedder, in-memory vector store, BM25, hybrid RRF search, reranking, metadata filters, tenant scoping, citations, context provider and search tool.
- **Memory (6):** `@agent-framework/memory`: conversation/user/entity/episodic/semantic memory with write policies, TTL, provenance, authorization, forget and purge, tools and context provider.
- **Planning / orchestration / multi-agent (7, 9, 10):** `@agent-framework/orchestration`: validated DAG plans, static and model planners, workers, bounded parallel execution, retries, re-planning, aggregation, supervisor, delegation with depth limits, pipeline, parallel.
- **Reflection (8):** verifier port with rule, citation, LLM-critic and cross-agent verifiers; bounded revision loop.
- **Security (11):** `@agent-framework/security`: PII, prompt-injection, secret-leak, content and length guardrails (input, tool result, output); RBAC, ABAC, tenant-isolation and data-classification policies; SSRF-safe egress and HTTP tools; secrets; claims → principal.
- **Observability (12):** `@agent-framework/observability`: OpenTelemetry spans and metrics, redaction, structured logs, JSONL traces, cost tracking, run inspection.
- **Evaluation (13):** `@agent-framework/evaluation`: datasets, 12 evaluators including LLM judge, thresholds, markdown reports, regression comparison.
- **Production (14):** `runtime.recover()` with pre-side-effect checkpoints; `@agent-framework/production` with PostgreSQL/SQLite stores, durable queues with leases, workers, service API, health checks, graceful shutdown, `createFramework()`.
- **Models:** `@agent-framework/provider-anthropic` (official SDK), OpenAI-compatible fetch adapter, circuit breaker, rate limit and fallback wrappers.
- **CLI:** `agent create | dev | test | evaluate | inspect | trace | validate` and JSON agent manifests.
- **Examples:** research agent, RAG agent, orchestrator, enterprise agent; `createRuleProvider` for offline scenarios.

### Added — Phase 2: tool system

- `@agent-framework/tools`: `defineTool()` with Zod input/output schemas and JSON Schema generation for models.
- `ToolRuntime`: parse → validate → authorize → approval → rate limit → idempotency → concurrency → execute (timeout, retry, backoff) → validate output → audit.
- Policies: `permissionPolicy()` (agent **and** user must hold each permission, wildcards supported), `allOf()`, `policy()`, `decisionPolicy()` (deterministic decision providers only). Fail-closed on policy errors.
- Human approval bound to tool call id and a SHA-256 hash of the validated arguments, with expiry; runs pause as `WAITING_FOR_APPROVAL` and continue with `agent.resume()`.
- Tool lifecycle events: `TOOL_REQUESTED`, `TOOL_AUTHORIZATION_STARTED/COMPLETED`, `TOOL_EXECUTION_STARTED/COMPLETED/FAILED/TIMED_OUT`, `TOOL_APPROVAL_REQUIRED/GRANTED/REJECTED`.
- Audit records with redaction for `sensitive` tools; raw exception messages are kept out of model context.
- Examples: `hello-agent`, `approval-agent`.

### Changed — Phase 1 stabilization

- Rebuilt `@agent-framework/core` so it compiles under strict TypeScript and has a real tool-calling loop.
- `createRuntime()` + `defineAgent()` replace `DefaultAgentRuntime`. Agents are bound to an explicit runtime; there are no globals.
- Events renamed to `LLM_CALL_*` and `TOOL_*` (previously `LLMCALL_*` / `TOOLCALL_*`) and wrapped in sequenced envelopes.
- `FrameworkError` (previously `BaseFrameworkError`) gains `category` and `toJSON()`.
- `RunLimits.timeout` is now `timeoutMs`; added `maxLLMRetries`, `maxCost`, `maxTokens` enforcement.
- LLM contract: `LLMProvider.id`, richer `ModelCapabilities` (locality, pricing, latency, data classifications).
- Tooling: one pnpm workspace, TypeScript 5.9, Vitest 3 projects, ESLint flat config, GitHub Actions CI.

### Removed

- `package-lock.json`, legacy `.eslintrc.cjs`, per-package Vitest configs and debug scripts.
