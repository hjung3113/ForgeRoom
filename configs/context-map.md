---
status: living
last_reviewed: 2026-05-22
---

# configs Context Map

## Responsibility

This folder stores ForgeRoom runtime registry config for projects, workflows, intents, agents, harnesses, and related policy files.

## Key Files

| File | Role |
|---|---|
| `intents.yaml` | Intent catalog mapping intent ids to kind, agent, and Step Harness |
| `agents.yaml` | Agent registry mapping agent ids to the Phase 1 `openclaw` provider runtime and model |
| `harnesses.yaml` | Step Harness registry mapping harness ids to managed `.forgeroom/harnesses/*` sources |
| `workflows.yaml` | Built-in Phase 1 workflow library for `quick`, `full`, and `hotfix` |
| `projects.yaml` | Local project registry entries and verification command metadata |

## Related Docs

- [Workflow DSL](../Docs/concepts/workflow-dsl.md)
- [AgentRunner](../Docs/modules/agent-runner.md)
- [ProjectRegistry](../Docs/modules/project-registry.md)
- [WorkflowRegistry](../Docs/modules/workflow-registry.md)

## Dependencies

- `apps/orchestrator/src/core/intent-registry.ts`
- `apps/orchestrator/src/core/agent-registry.ts`
- `apps/orchestrator/src/core/harness-registry.ts`
- `apps/orchestrator/src/core/workflow-registry.ts`
- `apps/orchestrator/src/core/project-registry.ts`

## Entry Guide

When editing a config registry, update or add registry tests first so invalid references fail before runtime.
