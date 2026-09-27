# Contributing

Thanks for helping build Agent Framework. This project favours small, reviewed, well-tested changes over large ones.

## Development setup

```bash
corepack enable
pnpm install
pnpm check        # typecheck + lint + test
```

| Command | What it does |
| --- | --- |
| `pnpm typecheck` | Builds all packages (`tsc -b`) and type-checks tests and examples |
| `pnpm lint` | ESLint (flat config, `typescript-eslint`) |
| `pnpm test` | Vitest across packages (`pnpm test --project tools` for one package) |
| `pnpm build` | Emits `dist/` for every package |
| `pnpm examples` (or `pnpm example:<name>`) | Runs the examples from source |

Tests and examples import packages from `src/` through path aliases, so no build step is needed while developing.

## Ground rules

1. **The runtime stays deterministic.** Authorization, limits, retries, persistence and audit are never delegated to a model.
2. **No vendor in the core.** `@agent-framework/core` must not import an LLM SDK, database driver, queue, OpenTelemetry or MCP. These are adapters.
3. **No globals.** Dependencies flow through `createRuntime()` / `ToolRuntime` options.
4. **No `any`** unless unavoidable. If you need it, add a comment explaining why.
5. **Every behaviour change has a test.** Security-relevant changes get a test in a `security.test.ts` that names the attack.
6. **Docs move with code.** Update the guide in `docs/` that describes the behaviour you changed.
7. **Don't add dependencies casually.** Justify new runtime dependencies in the PR using the checklist in [extension points](./docs/architecture/extension-points.md#adopting-external-projects).

## Architecture decisions

Changes to a public contract (`Agent`, `LLMProvider`, `ToolInvoker`, `RunStateStore`, events, error codes) or to package boundaries need an ADR in [`docs/decisions`](./docs/decisions/README.md). Copy the structure of an existing ADR.

## API stability

Everything exported from a package's `index.ts` is public API and follows semantic versioning once 1.0 ships. Exports marked `@experimental` may change in minor releases. Anything not exported is internal.

## Pull requests

- Keep PRs focused on one change.
- Make sure `pnpm check` passes locally.
- Describe *why*, not only *what*.
- Add an entry to [CHANGELOG.md](./CHANGELOG.md) under **Unreleased**.
