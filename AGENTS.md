# AGENTS.md

Instructions for AI coding agents (and humans) working in this repository.

## Project

TypeScript monorepo (pnpm workspaces) for an enterprise AI agent framework. 15 packages in `packages/*`, examples in `examples/*`, docs in `docs/*`. Start with [README.md](./README.md) and [docs/README.md](./docs/README.md).

## Setup and commands

```bash
corepack enable && pnpm install
pnpm check                 # typecheck (tsc -b + tests/examples) + lint + tests. Run before every commit.
pnpm test --project <pkg>  # tests for one package, e.g. --project tools
pnpm examples              # all examples must keep running
pnpm build                 # dist/ output
```

Node ≥ 20.3; SQLite tests need Node ≥ 22.5 (they skip otherwise). Tests and examples import package sources through path aliases (`tsconfig.dev.json`, `vitest.config.ts`), so no build is needed during development.

## Layout

| Path | Contents |
| --- | --- |
| `packages/core/src` | runtime (`runtime.ts`), agent definition (`agent.ts`), events, errors, LLM contract, ports, skills, reflection, guardrails, `testing.ts` |
| `packages/tools/src` | `defineTool`, `ToolRuntime` pipeline (`tool-runtime.ts`), policies, stores |
| `packages/<name>/src` | one subsystem per package; tests are `*.test.ts` next to sources |
| `docs/` | one guide per subsystem; `architecture/`, `decisions/` (ADRs), `security/` |

## Rules

1. **The runtime stays deterministic.** Authorization, limits, retries, persistence and audit are never delegated to a model.
2. **No vendor SDKs in `core`.** Vendors, databases, queues and protocols live in adapter packages.
3. **No globals.** Dependencies flow through `createRuntime()` / `ToolRuntime` options.
4. **Strict TypeScript.** Avoid `any` (lint error); `exactOptionalPropertyTypes` is on, so build objects with conditional spreads instead of assigning `undefined`.
5. **Every behaviour change has a test.** Security-relevant changes get a test named after the attack.
6. **Docs move with code.** Update the matching guide in `docs/`, the public API table and `CHANGELOG.md`.
7. **Public contract changes need an ADR** in `docs/decisions/`.
8. Use `createScriptedProvider` / `createRuleProvider` (`@agent-farmework/core/testing`) for deterministic tests; never call live models in tests.
