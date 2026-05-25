---
status: living
last_reviewed: 2026-05-25
---

# core/checks Rules

Read [context-map.md](context-map.md) first.

## Scope

Check execution and approval/admission decisions.

## Rules

- Depend on injected command/agent runners.
- Keep external command execution behind `utils/command-runner`.
- Do not import from `app/`, `gateway/`, or `db/`.

## Upstream Rules

- [core/AGENTS.md](../AGENTS.md)
