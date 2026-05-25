---
status: living
last_reviewed: 2026-05-23
---

# core/test-support Context Map

## Responsibility

Reusable test-only fakes and fixture builders for core module tests.

## Key Files

| File | Role |
|---|---|
| `check-runner-fixtures.ts` | CheckRunner fake AgentRunner, CommandRunner, TaskStore, artifact store, and fixture builders |
| `pipeline-engine-fixtures.ts` | PipelineEngine fake registries, task store, AgentRunner, CheckRunner, WorktreeManager, and artifact store |
| `pipeline-task-fixtures.ts` | Shared Task and Step builders for PipelineEngine recovery tests |
| `template-fixtures.ts` | Temp prompt-template root builder (`makeTestTemplateRoot`) and bundled Step Harness contracts (`makeTestHarnessContracts`, ADR-027) |

## Dependencies

- May import production `core` types and interfaces to keep test fakes honest.
- Must not be imported by production code.

## Entry Guide

1. Prefer small explicit builders over broad global fixtures.
2. Keep behavior fakeable and deterministic.
3. Add new helpers only when a test file would otherwise exceed the local readability threshold.
