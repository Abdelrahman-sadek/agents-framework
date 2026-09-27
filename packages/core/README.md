# @agent-farmework/core

Deterministic agent runtime: `defineAgent`, `createRuntime`, the run loop, explicit state, typed events, the error model, limits, and the ports the rest of the framework plugs into (`LLMProvider`, `ToolInvoker`, `RunStateStore`, `ContextManager`, `DecisionEngine`, `EventSink`).

Zero runtime dependencies.

```ts
import { createRuntime, defineAgent } from "@agent-farmework/core";
```

Test utilities live at `@agent-farmework/core/testing` (`createScriptedProvider`).

Docs: [Agents guide](../../docs/agents.md) · [Core runtime](../../docs/architecture/core-runtime.md) · [Public API](../../docs/architecture/public-api.md)
