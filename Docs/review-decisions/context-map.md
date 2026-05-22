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
| `2026-05-23-stage-4-worktree-bootstrap-boundary.md` | Stage 4 boundary between base worktree bootstrap and Stage 8 ForgeMap staging |
| `2026-05-23-stage-4-approval-gate-worktree-seam.md` | Stage 4 ApprovalGate seam for worktree branch/path safety |
| `2026-05-23-stage-5-openclaw-ipc-contract.md` | Stage 5 ForgeRoom-side OpenClaw IPC contract decision |
| `2026-05-23-stage-5-agent-runner-retry-policy.md` | Stage 5 AgentRunner output-producing retry policy decision |
| `2026-05-23-stage-5-agent-timeout-policy.md` | Stage 5 AgentRunner timeout default policy decision |

## Related Docs

- [Implementation plan](../plans/2026-05-22-goal-feature.md)
- [Workflow DSL](../concepts/workflow-dsl.md)
- [WorkflowRegistry](../modules/workflow-registry.md)
- [ProjectRegistry](../modules/project-registry.md)
- [TaskStore](../modules/task-store.md)
- [Data model](../concepts/data-model.md)
- [WorktreeManager](../modules/worktree-manager.md)
- [ApprovalGate](../modules/approval-gate.md)
- [AgentRunner](../modules/agent-runner.md)
- [Prompt file protocol](../concepts/prompt-file-protocol.md)
- [Doc rules](../rules/doc-rules.md)

## Dependencies

- Review outputs from adversarial subagents
- Canonical design docs and ADRs

## Entry Guide

Before reopening a review topic, search this folder for the module or stage name and check whether the decision was already recorded.
