---
status: living
last_reviewed: 2026-05-21
---

# db/ Rules

Read [context-map.md](context-map.md) first.

## Core rules

1. **Only the `TaskStore` implementation lives here.** The interface (`core/task-store.ts`) belongs to `core`.
2. **Migrations are mandatory.** Every schema change adds a new migration. Never edit an existing migration.
3. **Be explicit about transactions.** Multi-row inserts / updates run inside a single transaction.
4. **better-sqlite3 sync API is fine internally.** ForgeRoom is single-process; keep the externally exposed interface `async` so a future Postgres swap stays cheap.
5. **PRAGMAs:** WAL mode, `foreign_keys=ON`, sensible `busy_timeout`.

## Files

- `schema.ts` — Drizzle schema definitions
- `migrations/` — generated migration SQL
- `client.ts` — better-sqlite3 + Drizzle bootstrap
- `sqlite-task-store.ts` — TaskStore implementation
- `migrate.ts` — boot-time migration runner

## Forbidden

- Business logic (belongs in `core`)
- Raw SQL outside Drizzle (allowed only in performance-critical paths with an explicit comment)
- Down migrations during Phase 1

## Checklist

- [ ] Index definitions match [data-model](../../../../Docs/concepts/data-model.md)
- [ ] Idempotency-critical paths tested (`events.delivered_at`, `tasks` unique-active)
- [ ] Unit tests run against in-memory SQLite
- [ ] Migrations apply cleanly to an empty database

## Upstream rules

- [src/CLAUDE.md](../CLAUDE.md)
- [Data model](../../../../Docs/concepts/data-model.md)
- [Concurrency policy](../../../../Docs/policies/concurrency.md)
