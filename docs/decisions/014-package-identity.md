# ADR 014: Package identity and npm scope

**Status:** Accepted with unresolved publication naming

**Context**

The framework needs a package identity that supports a scoped namespace and avoids unnecessary conflict with existing ecosystems. A placeholder internal name is fine for Phase 0, but the publication identity should eventually be concrete.

**Decision**

For Phase 0 work, use the internal repository name **enterprise-agent-framework** and package names under an internal scoping convention such as `@agent-framework/*`.

This is a temporary working identity for the repository and package graphs. It is not a claim of npm availability.

**Rules**

- Do not publish anything under this identity until availability is checked explicitly.
- If a different scope is needed later, change the package names through a coordinated rename rather than ad-hoc edits.
- The naming should support scoped packages:
  - `@scope/core`
  - `@scope/llm`
  - `@scope/tools`
  - ...

**What was checked**

Best-effort checks indicate that generic scoped names in the AI-agent space are already crowded. For example, there are existing npm packages in related spaces such as `@classytic/arc-ai`. This means a careful, concrete availability check is required before publication, not a guess.

**Current recommendation**

- Keep `@agent-framework/*` as the working internal convention until publication.
- Before release, perform explicit availability checks and decide between:
  - a scoped namespace owned by the project/organization, if available
  - a different unique namespace if the obvious one is taken

**Open item**

npm publication naming is unresolved until availability is verified. This does not block Phase 1 implementation, because internal package names can be finalized before publishing.

**Consequences**

- Implementation can proceed without a finalized public scope.
- Publication naming must be verified before any publish.
- If the working name changes later, it should be a deliberate rename with a migration note.

## Update (publication)

The packages are published as `@agent-framework/*` to **GitHub Packages**, under the GitHub organization that owns the repository (the scope must match the organization name). npmjs.com publication is deferred until an npm account is available. The same names are kept, so moving later only changes the registry.
