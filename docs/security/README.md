# Security

Security is a first-class subsystem. The framework couples LLM-generated decisions with tool execution and data access, so the runtime must enforce deterministic controls around authorization, permissions, tenant isolation, guardrails, audit, and external-system boundaries.

## Trust boundaries

The framework's main trust boundaries are:

- **User identity and tenant context**
- **Agent identity**
- **Policy engine**
- **Tool runtime**
- **LLM gateway**
- **External systems and tools**
- **Observability and logging**

The LLM sits outside the trust boundary for authorization and runtime state. It may influence decisions, but it does not own authority.

## Authorization model

Authorization follows this model:

```
User Identity
    +
Agent Identity
    +
Tenant Context
    +
Tool Permission
    +
Data Permission
    │
    ▼
Policy Engine
    │
    ▼
Action
```

Authorization decisions are made by the runtime. The LLM's assertion that it is allowed to do something is not sufficient.

## Attack surfaces

The framework must design against:

- prompt injection
- tool abuse
- excessive agency
- data leakage
- SSRF
- credential exposure
- tenant isolation failures
- malicious documents
- supply-chain risks

### Prompt injection

Prompt injection is a primary risk because user input, retrieved documents, tool output, and memory content can all carry untrusted content into the model context.

Controls:

- treat retrieved documents and tool output as untrusted
- apply input/output guardrails
- avoid putting sensitive operational logic into prompts
- keep prompt-dependent behavior away from authorization and irreversible actions
- prefer structured, validated tool usage over free-form model action selection

### Tool abuse

Tools can create real effects. Tool abuse includes using tools outside intended scope, overusing them, or using them in unintended combinations.

Controls:

- schema validation for tool input
- deterministic authorization
- tool-level permissions
- timeout and retry limits
- rate limiting
- audit trail
- human approval for sensitive actions
- bounded agency through tool sets and worker permissions

### Excessive agency

Excessive agency happens when an agent can do more than necessary.

Controls:

- least-privilege tool sets
- worker isolation in orchestration
- scoped permissions
- budgets and limits
- explicit configuration for reflection, planning, and multi-agent use

### Data leakage

Data leakage can occur through outputs, telemetry, memory, retrieval, and external tool calls.

Controls:

- redaction policies for telemetry
- scope/ownership in memory
- metadata and filtering in retrieval
- tenant-aware data access
- output guardrails
- cautious logging and no blind logging of sensitive data

### SSRF

If agents can call external services or fetch URLs, SSRF is a real risk.

Controls:

- network egress controls where possible
- URL allowlists or validation for fetch-like tools
- sandboxing for unsafe tool execution where feasible
- treating external resource access as a security boundary, not a convenience

### Credential exposure

Agents may need secrets to call tools and services.

Controls:

- secret management outside agent prompts and tool definitions
- least-privilege credentials
- short-lived credentials where possible
- no embedding of secrets in logs, telemetry, or inputs
- separation of credential usage from LLM-visible context

### Tenant isolation

Multi-tenant use requires real isolation.

Controls:

- tenant-aware execution context
- tenant-scoped data access
- tenant-scoped memory and knowledge where appropriate
- policy enforcement that includes tenant identity
- explicit testing for cross-tenant access

### Malicious documents

RAG and document processing can introduce malicious or manipulated content.

Controls:

- treat document content as untrusted
- metadata and source tracking
- content safety checks where appropriate
- citation and source identity preservation
- limits on how much untrusted content enters context

### Supply-chain risks

The framework depends on TypeScript packages, LLM providers, vector stores, queue backends, and external tooling.

Controls:

- dependency management and review
- pin and review adapter dependencies
- avoid implicit trust in provider responses
- validate and constrain integration points
- maintain adapter boundaries so provider-specific weaknesses do not spread into the core

## Implemented controls

| Control | Where | Test coverage |
| --- | --- | --- |
| Model cannot reach `execute` except through `ToolRuntime` | `ToolInvoker` port, branded tools | `security.test.ts` |
| Only tools registered on the agent can be called | agent runtime (`TOOL_NOT_FOUND`) | `security.test.ts` |
| Schema validation of model-generated arguments (malformed JSON, wrong types, extra keys) | `ToolRuntime` | `security.test.ts`, `tool-runtime.test.ts` |
| Deterministic authorization: agent **and** user must hold each permission, fail closed | `permissionPolicy`, `allOf` | `security.test.ts` |
| LLM judges cannot authorize | `decisionPolicy` requires deterministic providers | `security.test.ts` |
| Approval bound to call id + argument hash, expiring, re-authorized on resume | `ToolRuntime`, agent runtime | `security.test.ts`, integration tests |
| Hard limits: steps, tool calls, tokens, cost, timeouts (enforced even when callees ignore signals) | agent runtime, `ToolRuntime` | `runtime.test.ts`, `security.test.ts` |
| Rate limits and concurrency limits per tool / tenant / user | `ToolRuntime` | `tool-runtime.test.ts` |
| Idempotent side effects | `ToolRuntime` idempotency | `tool-runtime.test.ts` |
| Tool metadata, permissions and denial reasons never sent to the model | tool definition export, error messages | `security.test.ts` |
| Raw exception messages kept out of model context | `ToolRuntime` | `tool-runtime.test.ts` |
| Sensitive inputs redacted from audit; events carry no arguments/outputs | `sensitive`, event design | `security.test.ts` |
| Audit record for every tool invocation, including denials | `AuditSink` | `tool-runtime.test.ts` |

| Input, tool-result and output guardrails (PII, prompt injection, secrets, content, length), fail closed | core runtime + `@agent-framework/security` | `runtime-extensions.test.ts`, `security` package tests |
| RBAC with nested roles, ABAC rules, tenant isolation on arguments, data classification vs. clearance | `@agent-framework/security` policies | `security.test.ts` |
| SSRF-safe egress: allow-list, https only, private/metadata address blocking after DNS, per-hop redirect checks, size/time caps | `createEgressPolicy`, `safeFetch`, `defineHttpTool` | `security.test.ts` |
| Secrets resolved inside tool execution only | `SecretProvider`, `envSecrets` | `security.test.ts` |
| Tenant-scoped knowledge and memory, memory write policy and ownership | `@agent-framework/knowledge`, `@agent-framework/memory` | package tests |
| Bounded delegation depth; delegates act for the same user | `agentAsTool` | `orchestration.test.ts` |
| Telemetry redaction; spans carry no content | `redactingSink`, `openTelemetrySink` | `observability.test.ts` |
| Production config refuses in-memory audit/state and missing budgets | `createFramework` | `production.test.ts` |
| Workspace confinement (absolute paths, traversal, symlink escapes) and approval-gated writes | `@agent-framework/sandbox` | `sandbox.test.ts` |
| Commands: no shell, allow-listed subcommands and flags, scrubbed env, time/output caps, approval | `commandTool` | `sandbox.test.ts` |
| MCP tools validated locally and authorized per server | `@agent-framework/mcp` | `mcp.test.ts` |
| Approval modifications re-validated and re-authorized; escalation cannot execute | tool runtime | `agent-tools.integration.test.ts` |
| Dashboard binds to localhost, is read-only and renders data as text | `createDashboardServer` | `observability.test.ts` |

Guides: [Security](../security.md), [Guardrails](../guardrails.md).

## Controls summary

Deterministic controls:

- identity and tenant context
- policy engine
- tool authorization
- permissions and scopes
- guardrails
- timeouts, retries, rate limits
- budgets
- audit logging
- redaction

Intelligence-influenced controls:

- reflection/verification
- input/output guardrails
- retrieval relevance and filtering
- memory policies

Important distinction: intelligence-influenced controls may help, but they do not replace deterministic controls.

## Security review expectations

At each phase, security review should check:

- whether any authorization decision depends too much on LLM output
- whether tool execution can bypass the runtime
- whether sensitive data can leak into logs or telemetry
- whether tenant isolation is enforced in the persistence and runtime layers
- whether external tool access is properly bounded
- whether approvals and irreversible actions are protected

## Security stance

The framework's security stance is:

- **never trust the LLM as the authority**
- **never allow tools to bypass the tool runtime**
- **never rely on prompts alone for permissions or invariants**
- **always keep execution state explicit and auditable**
- **always treat external data as untrusted by default**
