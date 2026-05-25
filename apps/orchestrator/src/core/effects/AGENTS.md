---
status: living
last_reviewed: 2026-05-25
---

# core/effects Rules

Read [context-map.md](context-map.md) first.

## Scope

Core-owned external-effect primitives that depend on narrow injected clients.

## Rules

- Keep orchestration in PipelineEngine or engine effect wrappers.
- Keep concrete API clients in `gateway/`.
- Do not import from `app/`, `gateway/`, or `db/`.

## Upstream Rules

- [core/AGENTS.md](../AGENTS.md)
