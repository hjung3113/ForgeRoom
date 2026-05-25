---
status: living
last_reviewed: 2026-05-25
---

# core/registries Rules

Read [context-map.md](context-map.md) first.

## Scope

Validated core registries for projects, workflows, and intents.

## Rules

- Keep parsing in `workflow/` or config loaders; registries own semantic validation.
- Do not import from `app/`, `gateway/`, or `db/`.
- Preserve registry error types for config diagnostics.

## Upstream Rules

- [core/AGENTS.md](../AGENTS.md)
