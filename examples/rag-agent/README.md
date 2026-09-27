# Example 3 — RAG agent

`Question → Knowledge retrieval → Context → LLM → Cited answer`

```bash
pnpm example:rag
```

- Hybrid (vector + BM25) retrieval with provenance, scoped to the user's tenant.
- Retrieved chunks are injected as delimited reference data. The PII guardrail redacts the email address before retrieval and the model call.
- `citationVerifier` rejects answers that cite nothing, or cite sources that were not provided.
