# ADR 012: Security model

**Status:** Accepted

**Context**

An AI agent framework can amplify risk because it couples LLM-generated decisions with tool execution and data access. Security cannot be an afterthought. Authorization must be deterministic, tenant isolation must be real, and the LLM must not be trusted as the source of authority.

**Decision**

Adopt a layered security model.

Authorization model:

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

The framework must never execute an action on the basis of "the LLM says it is allowed."

**Design rules**

- Identity is explicit for users, agents, and tenants.
- Permissions are enforced by the runtime, not by prompt content.
- Guardrails include both input and output controls.
- Audit logs record security-relevant events.
- Secret management, rate limiting, and resource limits are part of the model.
- Prompt-injection defenses are part of the framework, not an optional add-on.
- SSRF and data-leakage risks are addressed at the tool/external-system boundary.
- Tenant isolation is supported as a first-class concept.

**Attack surfaces to design against**

- prompt injection
- tool abuse
- excessive agency
- data leakage
- SSRF
- credential exposure
- tenant isolation failures
- malicious documents
- supply-chain risks in dependencies and integrations

**Alternatives considered**

- Trusting the agent to self-regulate
- Applying security only at the application layer
- Treating LLM-based checks as sufficient authorization

**Consequences**

- Security becomes a core subsystem, not a naming convention.
- The policy engine and tool runtime become critical trust boundaries.
- Some features become more complex because they must carry identity and permissions explicitly.
- Security review must continue during implementation, not just in architecture.
