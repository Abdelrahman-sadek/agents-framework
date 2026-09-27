# ADR 021: Agent manifest and developer CLI

**Status:** Accepted

**Decision**

- Manifests are JSON validated with Zod. Tools, context sources, guardrails and verifiers are referenced **by name** and resolved from an application registry. Manifests contain no code, so they can be reviewed, diffed and versioned; behaviour stays in typed code.
- Validation checks least privilege: every tool permission must be declared, and declared permissions must be used.
- The CLI uses `node:util` `parseArgs` (no CLI framework dependency) and is testable through an injectable IO object. It is an interface to the framework, not part of the runtime.
- YAML is not supported in the core toolchain, to avoid a parser dependency. Teams that prefer YAML can parse it themselves and pass the object to `defineAgentFromManifest`.

**Consequences**

- `agent validate` can run in CI for manifest changes, and `agent evaluate --baseline` gates regressions.
