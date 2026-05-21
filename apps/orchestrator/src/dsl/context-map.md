---
status: living
last_reviewed: 2026-05-21
---

# dsl/ Context Map

## Responsibility

Workflow yaml DSL handling: parsing, static validation, variable interpolation, foreach and until evaluation.

## Key files (planned)

| File | Role |
|---|---|
| `workflow-parser.ts` | yaml → `ParsedWorkflow` + static checks |
| `variable-interpolator.ts` | Substitute `${task.*}`, `${<step>.*}`, `${vars.*}` |
| `foreach.ts` | Evaluate `foreach` and extract the source list (markdown list, etc.) |
| `until.ts` | Evaluate `until` boolean expressions |
| `dsl-errors.ts` | `WorkflowParseError`, `InterpolationError`, etc. |
| `types.ts` | `ParsedWorkflow`, `ParsedStep`, `ForeachSpec`, etc. |

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
4. Cover each variable type in the interpolator tests
