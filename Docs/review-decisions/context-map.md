---
status: living
last_reviewed: 2026-05-22
---

# Docs/review-decisions Context Map

## Responsibility

This folder records implementation-level decisions settled during review so later agents do not reopen the same resolved debate.

## Key Files

| File | Role |
|---|---|
| `2026-05-22-stage-2-registry-validation.md` | Stage 2 decisions from workflow/project registry review |
| `2026-05-23-stage-3-task-store-row-types.md` | Stage 3 decision for durable TaskStore row types in core contracts |
| `2026-05-23-stage-3-task-store-completion.md` | Stage 3 completion decisions for failure reasons, conductor state, and lock integration |

## Related Docs

- [Implementation plan](../plans/2026-05-22-goal-feature.md)
- [Workflow DSL](../concepts/workflow-dsl.md)
- [WorkflowRegistry](../modules/workflow-registry.md)
- [ProjectRegistry](../modules/project-registry.md)
- [TaskStore](../modules/task-store.md)
- [Data model](../concepts/data-model.md)
- [Doc rules](../rules/doc-rules.md)

## Dependencies

- Review outputs from adversarial subagents
- Canonical design docs and ADRs

## Entry Guide

Before reopening a review topic, search this folder for the module or stage name and check whether the decision was already recorded.
