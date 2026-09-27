# Guardrails

Guardrails inspect text at three stages. They are deterministic by default; model-based classifiers can be added as custom guardrails or as decision providers.

```
Input → input guardrails → agent → tool results → tool_result guardrails → … → output guardrails → answer
                                     ↑ tool authorization happens in the tool runtime, independently
```

```ts
import { piiGuardrail, promptInjectionGuardrail, secretLeakGuardrail, contentPolicyGuardrail, maxLengthGuardrail } from "@agent-framework/security";

defineAgent({
  ...,
  guardrails: [
    maxLengthGuardrail({ maxChars: 20_000 }),
    piiGuardrail({ action: "redact" }),                          // input + output
    promptInjectionGuardrail({ threshold: 0.5 }),                // input + tool results
    secretLeakGuardrail(),                                       // tool results + output
    contentPolicyGuardrail({ deny: ["internal only", /\bproject titan\b/i], stages: ["output"] }),
  ],
});
```

| Result | Effect |
| --- | --- |
| `allow` | Continue |
| `redact` | Content is replaced. Redactions compose across guardrails. `GUARDRAIL_TRIGGERED` records it |
| `block` at `input` / `output` | Run fails with `GUARDRAIL_BLOCKED` (no model call for input blocks) |
| `block` at `tool_result` | The result is withheld from the model (it gets an error), and the run continues |
| guardrail throws | Treated as `block` (fail closed) |

Built-ins:

- **PII:** email, phone, payment cards (Luhn-checked), US SSN, IBAN, IP addresses.
- **Prompt injection:** weighted heuristics for instruction overrides, role hijacking, prompt exfiltration, fake delimiters, exfiltration requests, tool coercion and concealment. It is defense in depth: even an undetected injection cannot grant permissions, add tools or skip approvals.
- **Secret leak:** redacts API keys, cloud keys, GitHub/Slack tokens, private keys and JWTs.

Write your own by implementing `Guardrail { name, stages, check(content, ctx) }`. Guardrails also power the `evaluators.safety([...])` evaluator.
