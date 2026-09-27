# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Until 1.0, minor versions may contain breaking changes.

## [Unreleased]

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
