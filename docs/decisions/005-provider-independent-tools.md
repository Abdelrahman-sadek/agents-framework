# ADR 005: Provider-independent Tool architecture

**Status:** Accepted

**Context**

Tools are how agents interact with the world. They must be strongly validated, authorized, bounded, observed, and auditable. They must also support multiple transport and integration mechanisms, including MCP, without making any one protocol the internal definition of a tool.

**Decision**

Make `Tool` a first-class framework abstraction with its own runtime.

A tool includes:

- name
- description
- input schema
- execute logic
- permissions
- timeout
- retry policy

Tool execution is mediated by the tool runtime and follows this sequence:

```
LLM requests an action
    │
    ▼
Framework validates request
    │
    ▼
Authorization
    │
    ▼
Guardrails
    │
    ▼
Tool execution
    │
    ▼
Result validation
    │
    ▼
Audit
```

**Integration points**

Framework tools can have multiple transports:

- native tool
- HTTP tool
- database tool
- MCP tool
- internal service tool

MCP is an adapter/protocol integration, not the framework's internal tool definition.

**Alternatives considered**

- Making MCP the canonical tool representation
- Treating tools as informal function references
- Putting tool authorization in the LLM prompt

**Consequences**

- Tools can be integrated from many sources without protocol lock-in.
- Authorization and guardrails remain deterministic.
- Tool definitions are schema-driven and observable.
- Tool runtime becomes one of the most security-critical components in the framework.
