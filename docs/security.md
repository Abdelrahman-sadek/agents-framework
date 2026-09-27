# Security guide

The [security model](./security/README.md) and [threat model](./security/threat-model.md) explain the design. This guide shows how to use the controls. `@agent-farmework/security` provides guardrails, policies, egress control, secrets and identity mapping. The core enforces limits, and the tool runtime enforces authorization and approval.

## Identity

Authorization always combines **user identity + agent identity + tenant + tool/data permissions**. The identity comes from your authentication layer, never from a prompt:

```ts
const user = principalFromClaims(verifiedJwtClaims, { tenantId: "org_id", roles: "roles", permissions: "scope" });
await agent.run({ input, user });
```

## Authorization policies (tools)

```ts
new ToolRuntime({
  policy: allOf(
    rbacPolicy({ roles: { analyst: ["reports.read"], manager: ["role:analyst", "reports.export"] } }),
    tenantIsolationPolicy(),                      // arguments naming another tenant are denied
    dataClassificationPolicy(),                   // tool metadata.dataClassification vs user clearance
    abacPolicy([
      { name: "mfa-for-destructive", when: ({ tool, user }) => tool.metadata["destructive"] === true && user?.attributes?.["mfa"] !== true, effect: "deny", reason: "MFA required" },
      { name: "default", when: () => true, effect: "allow" },
    ]),
  ),
});
```

Policies are deterministic and fail closed. `decisionPolicy` only accepts deterministic decision providers.

## Egress and SSRF

```ts
const egress = createEgressPolicy({ allowHosts: ["api.weather.example", "*.docs.example.com"] });
const weather = defineHttpTool({
  name: "weather", description: "Current weather", input: z.object({ city: z.string() }),
  egress, secrets: envSecrets({ allow: ["WEATHER_KEY"] }),
  request: async ({ city }, secret) => ({ url: `https://api.weather.example/v1?city=${encodeURIComponent(city)}`, headers: { authorization: `Bearer ${await secret("WEATHER_KEY")}` } }),
});
```

Egress is deny-by-default. Only allow-listed hosts are reachable, only over `https:`, with no credentials in the URL. Addresses are resolved, and private, loopback, link-local or metadata addresses are blocked (this also stops DNS rebinding). Every redirect hop is re-checked, and response size and time are capped. Secrets are resolved inside `execute`, so they never reach the model, run state, events or audit.

## Checklist

- [ ] Tools declare least-privilege `permissions`; agents get only the permissions their tools need (`agent validate` checks manifests).
- [ ] Irreversible actions require `approval`; side effects use `idempotency`.
- [ ] `limits.maxCost` / `maxTokens` / `timeoutMs` are set for production (`createFramework` enforces it).
- [ ] Input and tool-result guardrails are on for user-facing and web/RAG agents ([Guardrails](./guardrails.md)).
- [ ] Telemetry goes through `redactingSink` ([Observability](./observability.md)).
- [ ] Knowledge documents and memories carry a `tenantId`.
