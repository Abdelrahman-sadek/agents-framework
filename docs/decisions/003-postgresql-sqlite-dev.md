# ADR 003: PostgreSQL for production, SQLite for local development

**Status:** Accepted

**Context**

Enterprise agents need durable relational persistence. Production environments need a robust, familiar database. Local development and testing benefit from a lightweight default.

**Decision**

- PostgreSQL is the canonical production database.
- SQLite is the default local development and testing store.
- Persistence is exposed through a repository/storage abstraction so the application API does not depend on the underlying engine.

**Design rules**

- Developers write `repository.save(...)` / `repository.find(...)` style code, not engine-specific queries.
- Migrations are supported where practical for both engines.
- PostgreSQL remains the reference implementation for production behavior.
- SQLite is not treated as the conceptual foundation of durable execution; it is one implementation choice.

**Why not PostgreSQL everywhere by default**

Local development should be easy to start, easy to isolate, and easy to reset. SQLite supports that well. Production durability, operational expectations, and enterprise integrations justify PostgreSQL.

**Alternatives considered**

- PostgreSQL everywhere, including dev
- Different databases per feature without a shared abstraction
- Pure in-memory state with no durable store

**Consequences**

- Developers get a low-friction local experience.
- Production architecture is PostgreSQL-native.
- The repository abstraction must be realistic enough to cover differences in migrations, locking, and concurrency without hiding them entirely.
- Engine-specific behavior still needs to be understood at integration boundaries.
