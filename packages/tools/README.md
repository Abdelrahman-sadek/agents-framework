# @agent-framework/tools

`defineTool` and the `ToolRuntime`, the only path from a model's tool request to execution:

parse → validate → authorize → approval → rate limit → idempotency → concurrency → execute (timeout, retry) → validate output → audit

```ts
import { ToolRuntime, defineTool, permissionPolicy } from "@agent-framework/tools";
```

Docs: [Tools guide](../../docs/tools.md) · [ADR 018](../../docs/decisions/018-tool-system.md) · [Security](../../docs/security/README.md)
