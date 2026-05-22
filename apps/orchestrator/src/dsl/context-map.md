---
status: living
last_reviewed: 2026-05-21
---

# dsl/ Context Map

## Responsibility

Workflow yaml DSL handling for Stage 2: parsing workflow config text into registry input objects and preserving source metadata for validation diagnostics. Runtime expression evaluation belongs to the Stage 7 `PipelineEngine` slice.

## Key files

| File | Role |
|---|---|
| `workflow-parser.ts` | yaml → workflow object parsing support; registry validation lives in `core/workflow-registry.ts` |
| `dsl-errors.ts` | `WorkflowParseError`, `InterpolationError`, etc. |
| `types.ts` | `ParsedWorkflow`, `ParsedStep`, `ForeachSpec`, etc. |

## Future Stage 7 / PipelineEngine-owned files

These are intentionally absent from current Stage 2 scope. Add them with the execution engine work that owns task state, step outputs, selector behavior, and runtime context.

| File | Future role |
|---|---|
| `variable-interpolator.ts` | Substitute `${task.*}`, `${<step>.*}`, `${vars.*}` at runtime |
| `foreach.ts` | Evaluate `foreach` sources such as `${task.final_slices}` |
| `until.ts` | Evaluate `until` boolean expressions such as `${review.passed}` |

## Related docs

- [Workflow DSL concept](../../../../Docs/concepts/workflow-dsl.md) — required reading
- [WorkflowRegistry module](../../../../Docs/modules/workflow-registry.md)
- [PipelineEngine module](../../../../Docs/modules/pipeline-engine.md) (DSL consumer)

## Dependencies

- External: `yaml` (eemeli/yaml)
- Internal: none (kept independent on purpose)

## Entry guide

1. Read the DSL concept doc end-to-end
2. Start with `types.ts` (define `ParsedWorkflow` / `ParsedStep`)
3. Write many parser unit tests (example yaml → expected object)
4. Keep runtime evaluator tests out of Stage 2; add them with Stage 7 `PipelineEngine` execution work
