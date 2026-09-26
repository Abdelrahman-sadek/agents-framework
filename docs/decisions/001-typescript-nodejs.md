# ADR 001: TypeScript and Node.js runtime

**Status:** Accepted

**Context**

The framework must run on the Node.js platform and must be usable by multiple enterprise teams. It must support strong typing, modern module architecture, and a developer experience that can scale across packages.

**Decision**

Use TypeScript on Node.js with strict configuration and ESM.

Specifically:

- TypeScript strict mode
- `noImplicitAny`
- `strictNullChecks`
- `noUncheckedIndexedAccess`
- ESM output
- modern module resolution suitable for Node.js

**Alternatives considered**

- JavaScript with runtime validation only
- TypeScript with lax settings for faster iteration
- A different runtime such as Deno or Bun as the primary target

**Consequences**

- Strong typing reduces a major class of runtime errors in a system that already depends heavily on runtime validation.
- ESM and strict config increase discipline but improve refactor safety.
- Node.js is the most broadly supported enterprise runtime in the target ecosystem.
- The framework will still need careful runtime validation because types alone do not guarantee correctness under LLM output, tool input, and external system boundaries.

**Notes**

TypeScript types are a design-time and compile-time guarantee. The framework must treat runtime schema validation as the trust boundary for external data, not TypeScript types.
