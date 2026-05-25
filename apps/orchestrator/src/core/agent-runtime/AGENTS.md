---
status: living
last_reviewed: 2026-05-25
---

# core/agent-runtime Rules

Read [context-map.md](context-map.md) first.

## Scope

Agent runtime abstractions, agent/harness registries, and the OpenClaw provider.

## Rules

- Keep SDK and process IO behind injected provider/client interfaces.
- Do not import from `app/`, `gateway/`, or `db/`.
- Preserve core contracts used by PipelineEngine and integration harnesses.

## Upstream Rules

- [core/AGENTS.md](../AGENTS.md)
