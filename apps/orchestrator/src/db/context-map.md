---
status: living
last_reviewed: 2026-05-21
---

# db/ Context Map

## Responsibility

SQLite schema, migrations, and the `TaskStore` implementation satisfying the `core` interface.

## Key files (planned)

| File | Role |
|---|---|
| `schema.ts` | Drizzle table definitions (tasks, steps, checks, events, conductor_state) |
| `client.ts` | better-sqlite3 + Drizzle bootstrap and PRAGMAs |
| `migrate.ts` | Boot-time migration runner |
| `migrations/` | Generated migration SQL (Drizzle CLI) |
| `sqlite-task-store.ts` | TaskStore implementation |

## Related docs

- [Data model](../../../../Docs/concepts/data-model.md) — required reading
- [TaskStore module spec](../../../../Docs/modules/task-store.md)
- [Concurrency policy](../../../../Docs/policies/concurrency.md)
- [ADR-002 SQLite adoption](../../../../Docs/decisions/2026-05-21-002-storage-sqlite.md)

## Dependencies

- External: `better-sqlite3`, `drizzle-orm`, `drizzle-kit` (dev)
- Internal: `core/` (TaskStore interface), `utils/` (logger)

## Entry guide

1. Confirm the schema against the data-model doc
2. Author the Drizzle schema
3. Run `drizzle-kit generate` to create the initial migration
4. Implement TaskStore methods one at a time with unit tests
5. Add integration tests for unique indexes and transactional flows
