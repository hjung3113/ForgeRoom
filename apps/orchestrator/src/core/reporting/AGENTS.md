---
status: living
last_reviewed: 2026-05-25
---

# core/reporting Rules

Read [context-map.md](context-map.md) first.

## Scope

Reporter facade, outbox behavior, and destination sink contracts.

## Rules

- Reporter failures must remain best-effort and must not fail tasks.
- Keep concrete Discord/GitHub SDK clients in `gateway/`.
- Do not import from `app/`, `gateway/`, or `db/`.

## Upstream Rules

- [core/AGENTS.md](../AGENTS.md)
