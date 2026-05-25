---
status: living
last_reviewed: 2026-05-25
---

# core/conductor Rules

Read [context-map.md](context-map.md) first.

## Scope

Conductor business logic and its narrow git/agent interfaces.

## Rules

- Depend on injected git and agent interfaces.
- Keep concrete git CLI code in `app/`.
- Do not import from `app/`, `gateway/`, or `db/`.

## Upstream Rules

- [core/AGENTS.md](../AGENTS.md)
