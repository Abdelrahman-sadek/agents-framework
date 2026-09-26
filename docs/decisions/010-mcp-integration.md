# ADR 010: MCP as an integration adapter, not the internal tool model

**Status:** Accepted

**Context**

MCP is a useful protocol for exposing tools and resources. It should be supported. However, it should not become the internal definition of a tool because that would create protocol lock-in and reduce flexibility.

**Decision**

The framework adopts one internal `Tool` abstraction. MCP is one transport/integration mechanism on top of that abstraction.

Internal model:

```
Framework Tool
 ├── Native
 ├── HTTP
 ├── Database
 ├── MCP
 └── Custom
```

**Design rules**

- The framework should be able to expose its tools through MCP where useful.
- MCP tools should map cleanly into the framework tool model.
- Tool authorization, validation, and audit should remain framework responsibilities, not MCP responsibilities alone.

**Alternatives considered**

- Making MCP the canonical tool definition
- Treating MCP as only an external plugin system with no internal mapping
- Ignoring MCP entirely

**Consequences**

- MCP support becomes an integration layer, not a core identity.
- The framework can interoperate with MCP ecosystems without being defined by them.
- Mapping between MCP semantics and framework semantics must be explicit and documented.
