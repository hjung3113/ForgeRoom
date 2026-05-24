---
status: living
last_reviewed: 2026-05-25
---

# core/engine Rules

Read [context-map.md](context-map.md) first.

## Core rules

1. Keep PipelineEngine internals behavior-preserving unless a task explicitly changes semantics.
2. Do not depend on concrete adapters from `app/`, `gateway/`, or `db/`.
3. Depend on narrow injected interfaces and callbacks instead of raw `PipelineEngineDeps`.
4. Preserve Mastra adapter contracts from `dsl/to-mastra.ts`.

## Upstream rules

- [core rules](../AGENTS.md)
- [PipelineEngine module](../../../../../Docs/modules/pipeline-engine.md)
