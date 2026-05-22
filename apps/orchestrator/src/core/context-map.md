---
status: living
last_reviewed: 2026-05-21
---

# core/ Context Map

## Responsibility

The business logic of ForgeRoom: workflow execution, agent orchestration, worktree management, task state machine, and notifications. All external IO is reached through adapters in sibling folders.

## Key files

| File | Module | Spec |
|---|---|---|
| `pipeline-engine.ts` | PipelineEngine | [Docs/modules/pipeline-engine.md](../../../../Docs/modules/pipeline-engine.md) |
| `conductor.ts` | Conductor | [Docs/modules/conductor.md](../../../../Docs/modules/conductor.md) |
| `agent-runner.ts` | AgentRunner (delegates to OpenClaw) | [Docs/modules/agent-runner.md](../../../../Docs/modules/agent-runner.md) |
| `openclaw-provider.ts` | MVP OpenClaw AgentRuntimeProvider implementation | [Docs/modules/agent-runner.md](../../../../Docs/modules/agent-runner.md) |
| `worktree-manager.ts` | WorktreeManager | [Docs/modules/worktree-manager.md](../../../../Docs/modules/worktree-manager.md) |
| `check-runner.ts` | CheckRunner | [Docs/modules/check-runner.md](../../../../Docs/modules/check-runner.md) |
| `reporter.ts` | Reporter | [Docs/modules/reporter.md](../../../../Docs/modules/reporter.md) |
| `approval-gate.ts` | ApprovalGate | [Docs/modules/approval-gate.md](../../../../Docs/modules/approval-gate.md) |
| `project-registry.ts` | ProjectRegistry | [Docs/modules/project-registry.md](../../../../Docs/modules/project-registry.md) |
| `workflow-registry.ts` | WorkflowRegistry | [Docs/modules/workflow-registry.md](../../../../Docs/modules/workflow-registry.md) |
| `output-selectors.ts` | PipelineEngine output selector parsing helpers | [Docs/modules/pipeline-engine.md](../../../../Docs/modules/pipeline-engine.md) |
| `pipeline-paths.ts` | PipelineEngine task branch, worktree, and step artifact path builders | [Docs/concepts/prompt-file-protocol.md](../../../../Docs/concepts/prompt-file-protocol.md) |
| `intent-registry.ts` | Intent registry validation and lookup | [Docs/concepts/workflow-dsl.md](../../../../Docs/concepts/workflow-dsl.md) |
| `agent-registry.ts` | Phase 1 OpenClaw agent registry validation and lookup | [Docs/modules/agent-runner.md](../../../../Docs/modules/agent-runner.md) |
| `harness-registry.ts` | Step Harness registry validation and lookup | [Docs/concepts/workflow-dsl.md](../../../../Docs/concepts/workflow-dsl.md) |
| `task-store.ts` | TaskStore interface and create-task input contract | [Docs/modules/task-store.md](../../../../Docs/modules/task-store.md) |
| `types.ts` | Exported task, step, check, and shared contract types | [Docs/concepts/data-model.md](../../../../Docs/concepts/data-model.md) |
| `errors.ts` | Domain error classes with canonical failure codes | [Docs/concepts/data-model.md](../../../../Docs/concepts/data-model.md) |
| `__tests__/` | Unit tests for core modules, separated from implementation files | [Docs/rules/testing-rules.md](../../../../Docs/rules/testing-rules.md) |
| `test-support/` | Shared core test fakes and fixture builders | [Docs/rules/testing-rules.md](../../../../Docs/rules/testing-rules.md) |

## Import direction

- `core → utils` only
- Modules within `core` may freely depend on each other (PipelineEngine composes most others)

## Related docs

- [Workflow DSL](../../../../Docs/concepts/workflow-dsl.md)
- [Data model](../../../../Docs/concepts/data-model.md)
- [Conductor model](../../../../Docs/concepts/conductor-model.md)
- [Prompt file protocol](../../../../Docs/concepts/prompt-file-protocol.md)
- [Error / retry policy](../../../../Docs/policies/error-retry.md)

## Entry guide

1. Read the matching module spec end-to-end
2. Start by moving its "Interface" section into `types.ts`
3. Implement one method at a time, driven by unit tests
