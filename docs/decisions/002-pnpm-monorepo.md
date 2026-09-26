# ADR 002: pnpm monorepo

**Status:** Accepted

**Context**

The framework is composed of multiple cohesive subsystems. Those subsystems share types, interfaces, and testing conventions, but they must have clear ownership boundaries and low coupling.

**Decision**

Use a pnpm workspace monorepo.

- A modest number of packages, roughly 8-12
- Cohesive package boundaries rather than one package per small abstraction
- Shared TypeScript and lint configuration at the repo level
- Workspace-aware dependency management

**Intended package boundaries**

- `core`
- `llm`
- `tools`
- `context`
- `knowledge`
- `memory`
- `orchestration`
- `security`
- `observability`
- `evaluation`
- `cli`

**When Turborepo would be justified**

Turborepo would be added only if there is a concrete benefit such as caching, task orchestration across many packages, or remote build caching. It is not added simply because it is popular.

**Alternatives considered**

- Single package with internal folders
- npm workspaces
- Larger number of tiny packages

**Consequences**

- Clear ownership: each package has a defined responsibility.
- Low coupling: interfaces can be shared without merging all runtime code into one large package.
- Future flexibility: internal structure can change without breaking the public API if package boundaries are designed deliberately.
- Some overhead: a monorepo requires disciplined dependency management, especially around peer dependencies and internal contracts.
