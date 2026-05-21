---
status: living
last_reviewed: 2026-05-21
---

# core/ Rules

Read [context-map.md](context-map.md) first.

## Core rules

1. **Do not call external packages directly.** Anything talking to `discord.js`, `Octokit`, `child_process`, `fs.promises`, or OpenClaw IPC must go through an adapter in `gateway/`, `db/`, or `utils/`.
2. **Stay pure business logic.** `core` must not import from sibling folders.
3. **Depend on interfaces.** Persistence (`TaskStore`) and similar concerns are consumed via interfaces. Implementations live in `db/`.
4. **State changes go through `TaskStore`.** No ad-hoc in-memory state. (Exception: explicit in-process structures like `Map<projectId, Lock>` for concurrency.)
5. **Define and throw typed errors.** Never use bare strings; never use empty catch blocks.

## Module layout

Each module owns a file:

- `pipeline-engine.ts`
- `conductor.ts`
- `agent-runner.ts`
- `worktree-manager.ts`
- `check-runner.ts`
- `reporter.ts`
- `approval-gate.ts`
- `project-registry.ts`
- `workflow-registry.ts`
- `openclaw-agent-registry.ts`
- `task-store.ts` (interface only)

Tests live next to the source as `<name>.test.ts`.

Shared public types live in `types.ts`.

## Checklist

- [ ] External dependencies abstracted behind interfaces
- [ ] No imports from `gateway/`, `db/`, or `dsl/`
- [ ] Unit tests mock external dependencies
- [ ] The implementation matches its [module spec](../../../../Docs/modules/) interface

## Upstream rules

- [src/CLAUDE.md](../CLAUDE.md)
- [Coding rules](../../../../Docs/rules/coding-rules.md)
