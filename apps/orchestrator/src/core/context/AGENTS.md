---
status: living
last_reviewed: 2026-05-25
---

# core/context Rules

Read [context-map.md](context-map.md) first.

## Scope

ForgeMap and task-context staging logic.

## Rules

- Keep repo probing and persistence behind injected interfaces.
- Do not import from `app/`, `gateway/`, or `db/`.
- Path safety checks must stay explicit at file boundaries.

## Upstream Rules

- [core/AGENTS.md](../AGENTS.md)
