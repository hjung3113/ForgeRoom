---
status: living
last_reviewed: 2026-05-25
---

# core/worktree Rules

Read [context-map.md](context-map.md) first.

## Scope

Worktree lifecycle business logic and narrow filesystem/git interfaces.

## Rules

- Keep concrete git and filesystem implementations outside `core/`.
- Preserve idempotent worktree/bootstrap behavior.
- Do not import from `app/`, `gateway/`, or `db/`.

## Upstream Rules

- [core/AGENTS.md](../AGENTS.md)
