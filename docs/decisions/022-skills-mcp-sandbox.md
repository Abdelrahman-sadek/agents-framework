# ADR 022: Skills, MCP and sandbox capabilities

**Status:** Accepted

**Decision**

- **Skills** are data merged into agent configuration at `defineAgent` time: instructions, tools, permissions, context, guardrails, verifiers and dependencies. The runtime has no skill-specific code, so every existing control applies unchanged. Merging is idempotent, and conflicting tool names are configuration errors.
- **MCP** stays an adapter package (`@agent-framework/mcp`) on the official SDK. Remote JSON Schemas are converted to Zod (`z.fromJSONSchema`) so arguments are validated locally before any call. Each server gets its own permission namespace, and approval rules are per tool.
- **Sandbox** capabilities are separate, narrow tools (read, list, search, write, run command) rather than one "shell" tool. Confinement is enforced in code (path resolution including symlinks; no shell; allow-listed subcommands and flags; scrubbed env; caps). Stronger isolation plugs in through a `SandboxRunner` port without changing tool definitions.

**Consequences**

- The local runner is not a security boundary against a malicious binary. Production deployments that run untrusted code need a container or VM runner.
- MCP servers are trusted to execute what they advertise; the framework controls *whether* a call is made, not what the server does.
