---
status: living
last_reviewed: 2026-05-25
---

# core/agent-runtime Rules

Read [context-map.md](context-map.md) first.

## Scope

Provider-neutral agent runtime abstractions and agent/harness registries. The
concrete agent-runtime provider lives in `app/` (ADR-023 scope B, #71); this
folder must stay free of provider-specific symbols.

## Rules

- Keep SDK and process IO behind injected provider/client interfaces.
- Do not import from `app/`, `gateway/`, or `db/`.
- Preserve core contracts used by PipelineEngine and integration harnesses.

## Upstream Rules

- [core/AGENTS.md](../AGENTS.md)
