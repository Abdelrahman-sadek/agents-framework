# Example 6 — Enterprise agent

A refund-resolution service that uses every subsystem:

| Concern | How |
| --- | --- |
| Planning / workers | Orchestrator with investigate → decide → act → reply |
| Tools | `lookup_order`, `issue_refund` with schemas, permissions, idempotency |
| Security | RBAC roles + tenant-isolation policy; the refund is executed by a deterministic worker, not the model |
| Human approval | Refunds above 100 EUR return `approval_required` |
| RAG | Policy knowledge base with citations |
| Memory | User preference recalled by the reply writer |
| Reflection | Citation and rule verifiers with correction |
| Guardrails | PII redaction (the card number never reaches a model), prompt injection, secret leaks |
| Observability | Cost tracking by agent, audit log, run inspection |
| Evaluation | Golden dataset with content and safety evaluators |

```bash
pnpm example:enterprise
```
