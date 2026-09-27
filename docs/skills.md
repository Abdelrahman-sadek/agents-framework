# Skills

A **skill** is a reusable, testable capability, not a prompt string. It bundles scoped instructions with everything they need:

```ts
import { defineSkill, citationVerifier } from "@agent-framework/core";

export const citing = defineSkill({
  name: "citing",
  description: "Answer only from sources and cite them",
  instructions: "Cite every claim as [n] using the reference material. Say so when the sources do not answer.",
  verifiers: [citationVerifier()],
});

export const orderSupport = defineSkill({
  name: "order-support",
  version: "1.2.0",
  description: "Look up orders and explain their status",
  instructions: "Always look the order up before answering. Never guess delivery dates.",
  tools: [lookupOrder],
  permissions: ["orders.read"],
  context: [policies.asContextProvider({ k: 2 })],
  guardrails: [piiGuardrail()],
  dependsOn: [citing],
  examples: [{ input: "Where is ord-17?", output: "Order ord-17 was delivered on 3 May [1]." }],
  evaluation: { cases: [{ id: "status", input: "Where is ord-17?", expected: "delivered" }], minPassRate: 1 },
});

const agent = defineAgent({ name: "support", model, instructions: "You are Acme support.", skills: [orderSupport], runtime });
```

`defineAgent` resolves dependencies (dependencies first, deduplicated, cycles rejected) and merges:

- each skill's instructions as a `## Skill: <name>` section with its examples;
- tools (a different tool with the same name is a configuration error);
- permissions, context providers, guardrails and verifiers.

Merging is idempotent, so `defineAgent({ ...agent.config })` does not duplicate anything.

Evaluate a skill on its own cases:

```ts
defineEvaluation({ name: "order-support", dataset: skillDataset(orderSupport), target: agent, evaluators: [evaluators.contains()] });
```
