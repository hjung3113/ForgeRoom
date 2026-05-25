---
status: living
last_reviewed: 2026-05-25
---

# core/worktree Context Map

## Responsibility

Task worktree preparation and `.forgeroom` bootstrap behavior, including staging the bundled Step Harness contracts into `.forgeroom/harnesses/<id>` (ADR-027).

## Key Files

| File | Role |
|---|---|
| `worktree-manager.ts` | WorktreeManager + injected git/filesystem contracts; stages injected `harnessContracts` into `.forgeroom/harnesses/<id>` at bootstrap |
