# ADR 006: PostgreSQL + pgvector as the reference vector store

**Status:** Accepted

**Context**

Enterprise RAG needs retrieval over documents with metadata, citations, filtering, and hybrid search. Organizations already run PostgreSQL. Adding a separate mandatory vector database increases operational complexity and reduces portability.

**Decision**

Use PostgreSQL + pgvector as the primary reference implementation for the Knowledge subsystem.

The Knowledge API sits above:

- an `EmbeddingProvider` interface
- a `VectorStore` interface

The reference implementation uses PostgreSQL + pgvector for vector storage and retrieval, with metadata filtering and hybrid retrieval where appropriate.

**Design rules**

- The `VectorStore` interface remains provider-independent.
- The framework must preserve document/source identity for citation.
- Metadata filtering, hybrid retrieval, and reranking are supported as capabilities or extension points.
- Future adapters may include Qdrant, Pinecone, Weaviate, Milvus, and others, but they are not mandatory now.

**Embedding providers**

Embedding providers are also pluggable. The framework should allow local/free options for development and hosted or custom providers for production, without making any provider part of the core.

**Alternatives considered**

- Require a separate vector database for all deployments
- Build retrieval without a real vector store abstraction
- Hard-code one embedding provider

**Consequences**

- Enterprises can start with a database they already understand.
- Provider independence is preserved for embeddings and vector storage.
- pgvector behavior, indexing, and query patterns still need careful integration testing.
- Hybrid search and reranking require explicit design choices and may depend on provider capabilities.
