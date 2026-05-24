---
status: living
last_reviewed: 2026-05-25
---

# workflow/ Rules

Read [context-map.md](context-map.md) first.

## Core rules

1. Keep this layer neutral. It owns shared workflow contracts, schema, and expression grammar.
2. Do not import from sibling folders: `core/`, `dsl/`, `gateway/`, `db/`, `app/`, or `studio/`.
3. Prefer type-only exports for cross-folder contracts.
4. Runtime IO, registry semantic validation, and Mastra builder behavior belong to callers.

## Upstream rules

- [src rules](../AGENTS.md)
- [Workflow DSL concept](../../../Docs/concepts/workflow-dsl.md)
