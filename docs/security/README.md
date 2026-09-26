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
