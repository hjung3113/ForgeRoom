---
status: living
last_reviewed: 2026-05-25
---

# core/engine Context Map

## Responsibility

Internal PipelineEngine support modules. These files split orchestration helpers
out of `pipeline-engine.ts` without changing the public PipelineEngine contract.

## Key files

| File | Role |
|---|---|
| `step-collaborators.ts` | Per-run Mastra adapter collaborators for prompt rendering (harness contract + step template composition, ADR-027), agent execution, checks, conductor update, and reporting |
| `pull-request-external-effect.ts` | Task-critical PR external effect wrapper used by PipelineEngine settle |
| `branch-publication-external-effect.ts` | Task-critical branch-publication effect wrapper (ADR-025): commit+push before PR, no-diff detection |

## Dependencies

- Internal: `core/` interfaces, `pull-request-creator.ts`, and `dsl/to-mastra.ts` adapter contracts.
- External adapters: none.

## Notes

- `StepCollaborators` is per task run. Do not share instances across workflow builds.
- `asAdapterCollaborators()` returns arrow wrappers so Mastra can call extracted functions without losing `this`.
