# Configuration architecture

Configuration is layered. The framework should distinguish three levels clearly.

## Three configuration levels

### Framework configuration

Framework-level configuration wires major subsystems.

Example:

```typescript
const framework = createFramework({
  persistence,
  observability,
  execution,
  security,
});
```

Framework configuration is about choosing and connecting infrastructure.

### Agent configuration

Agent configuration declares what an agent is and how it behaves by default.

Example:

```typescript
const agent = defineAgent({
  name: "research-agent",
  model,
  instructions: `...`,
  tools: [searchTool],
  output: ResearchReportSchema,
  limits: { maxSteps: 20 },
});
```

Agent configuration should be declarative and mostly static.

### Run configuration

Run configuration overrides behavior for a specific execution.

Example:

```typescript
const result = await agent.run({
  input: "Research...",
  metadata: { ticketId: "123" },
  limits: { timeout: "2m" },
});
```

Run configuration should not redefine the agent's identity or permanently change its capabilities.

## Separation rules

- Framework configuration answers "which backend services does this deployment use?"
- Agent configuration answers "what is this agent, and what can it normally do?"
- Run configuration answers "how should this particular run behave?"

These should not be merged into one large object.

## Validation

Configuration should be validated early.

- Invalid framework configuration should fail startup.
- Invalid agent configuration should fail at definition time where possible.
- Invalid run configuration should fail fast before execution.

## Extensibility

Configuration objects should be composable. A simple agent definition should remain simple, and additional capabilities should be added through optional configuration objects.

## Durability and defaults

Default configuration should be safe and conservative. Advanced configuration should be explicit.

If a capability has production risk, it should be opt-in or explicitly configurable rather than implicit.

## Environment and secrets

Secrets and environment-specific configuration should be loaded outside the agent API. Agent definitions should receive configured services, not raw environment parsing, wherever practical.
