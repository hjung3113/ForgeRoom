---
status: living
last_reviewed: 2026-05-21
---

# dsl/ Rules

Read [context-map.md](context-map.md) first.

## Core rules

1. **Prefer pure functions.** Parser, interpolator, and evaluator should be input → output transformations as much as possible.
2. **No external IO.** File reads and writes belong to the caller (`core`). `dsl` only sees strings and objects.
3. **Errors carry source location.** Surface yaml line and field information whenever something fails to parse or evaluate.
4. **Fail fast.** Missing variables or references to unknown step ids must raise immediately.

## Files

- `workflow-parser.ts` — yaml → `ParsedWorkflow`
- `variable-interpolator.ts` — `${...}` substitution
- `foreach.ts` — foreach evaluation (list extraction)
- `until.ts` — until condition evaluation
- `dsl-errors.ts` — domain errors
- `types.ts`

## Forbidden

- File system access (belongs in `core/WorktreeManager`)
- LLM invocation (Conductor territory)
- Importing from `core` (keep `dsl` independent as far as possible)

## Checklist

- [ ] Variable interpolation cases covered by unit tests
- [ ] yaml line information preserved in error messages
- [ ] Missing-variable fail-fast verified
- [ ] foreach / until executed end-to-end in a test

## Upstream rules

- [src/AGENTS.md](../AGENTS.md)
- [Workflow DSL concept](../../../../Docs/concepts/workflow-dsl.md)
