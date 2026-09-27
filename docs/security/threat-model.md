# Threat model

This threat model focuses on the framework's most important risk areas: untrusted input reaching the model, model-influenced actions reaching tools, sensitive data leaving the system, and tenancy or credential boundaries being violated.

## Assumptions

- The LLM may be influenced by untrusted content: user input, retrieved documents, tool output, and memory content.
- Tools can produce real effects beyond the framework.
- External systems may be untrusted or partially untrusted.
- Tenants and users must be isolated appropriately.
- Observability data must not become a second leak path for sensitive information.

## High-level threats

### T1: Prompt injection via user input

Untrusted user input can steer the model toward unintended tool usage, disclosure, or instruction following outside policy.

Mitigations:

- treat user input as untrusted
- use guardrails
- keep authoritative decisions in the runtime
- limit what the model can request directly

### T2: Prompt injection via retrieved knowledge

Retrieved documents may contain instructions or content that manipulate the model.

Mitigations:

- treat retrieval results as untrusted
- preserve source identity and citations
- limit context injection of raw untrusted content
- apply output checks for sensitive actions

### T3: Tool call manipulation

The model may request tool calls with crafted inputs designed to bypass expectations.

Mitigations:

- validate tool input against schema
- authorize every tool call
- apply guardrails before execution
- log and audit tool calls
- apply human approval for sensitive operations

### T4: Excessive tool agency

An agent with broad tool access can do too much.

Mitigations:

- least-privilege tool sets
- worker isolation
- scoped permissions
- budgets and limits
- restricted tool definitions

### T5: Sensitive data leakage through outputs

Outputs may expose internal data, other tenants' data, or sensitive context.

Mitigations:

- output guardrails
- tenant-aware data access
- memory scope/ownership
- redaction
- careful response assembly

### T6: Sensitive data leakage through telemetry

Traces, metrics, and logs may expose prompts, tool arguments, documents, or user data if logged blindly.

Mitigations:

- redaction policies
- configurable telemetry detail
- no blind logging of sensitive fields
- production telemetry should be explicitly privacy-reviewed

### T7: SSRF and unsafe external access

Tools that fetch URLs or call external services can be abused for SSRF or unintended access.

Mitigations:

- validate and constrain external access
- use allowlists where feasible
- isolate unsafe tool execution
- treat external calls as security boundaries

### T8: Credential exposure

Secrets used by tools or providers may leak into prompts, logs, or tool output.

Mitigations:

- separate secret storage from LLM-visible context
- avoid logging secrets
- use least-privilege and short-lived credentials
- protect secret material in memory and persistence

### T9: Tenant isolation failure

Agent execution or data access may cross tenant boundaries.

Mitigations:

- tenant context in execution
- tenant-scoped policies
- tenant-scoped memory/knowledge where relevant
- explicit isolation tests

### T10: Approval bypass or loss

Approval-controlled actions are sensitive. If approval state is lost or bypassed, irreversible actions may occur without consent.

Mitigations:

- persist approval state
- make approval part of the durable execution model
- enforce authorization around approval decisions
- support expiration and escalation safely

### T11: Denial of wallet / cost abuse

Unbounded agent execution can create excessive cost.

Mitigations:

- budgets
- token and step limits
- retry caps
- cost tracking
- ability to stop execution when limits are exceeded

### T12: Dependency and provider abuse

Vulnerabilities or misuse in dependencies, provider SDKs, or external services can affect the framework.

Mitigations:

- adapter isolation
- dependency review
- cautious handling of provider responses
- clear boundaries between provider-specific behavior and core logic

## Mitigation status (after Phase 2)

| Threat | Status |
| --- | --- |
| T1, T2 Prompt injection | **Partial.** Injected text cannot grant permissions, add tools, or bypass validation, approval or limits. Detection is Phase 11. |
| T3 Tool call manipulation | **Mitigated** at the tool boundary: schema validation, deterministic policy, argument-bound approvals. |
| T4 Excessive tool agency | **Mitigated:** per-agent tool lists, dual (agent + user) permissions, approval, `maxToolCalls`, rate and concurrency limits. |
| T5 Leakage through outputs | Open (guardrails, Phase 11). Raw tool exceptions are no longer echoed to the model. |
| T6 Leakage through telemetry | **Partial:** events carry no content; sensitive tool input redacted in audit. OTel redaction in Phase 12. |
| T7 SSRF | Open until the HTTP adapter (egress allow-list) ships. |
| T8 Credential exposure | **Partial:** tool metadata is never sent to models; secrets stay in adapters. |
| T9 Tenant isolation | **Partial:** tenant is part of every authorization request, idempotency keys and rate-limit buckets. Storage isolation arrives with durable adapters. |
| T10 Approval bypass or loss | **Mitigated** for bypass (binding, expiry, re-authorization); loss depends on a durable `RunStateStore`. |
| T11 Denial of wallet | **Mitigated:** step, token, cost, tool-call and time budgets. |
| T12 Dependency abuse | Core has zero runtime dependencies; tools add only `zod`. |

## Trust levels

- **Trusted:** runtime code, policy engine, authorization checks, persistence of authoritative state, approval records, audit logs
- **Partially trusted:** provider adapters, tool implementations, retrieval backends
- **Untrusted:** user input, retrieved documents, tool output, memory content used as context, any data generated under adversarial influence

## Security principles

- Authorization is deterministic.
- Tool execution is mediated.
- State is explicit.
- Sensitive data is protected in transit, at rest, and in telemetry.
- External content is untrusted by default.
- Multi-tenancy is enforced in more than one layer.
