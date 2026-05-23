---
status: decided
date: 2026-05-23
scope: Stage 4 ApprovalGate worktree safety
---

# Stage 4 ApprovalGate Worktree Seam

## Decision

`ApprovalGate.checkWorkflow` accepts the real `ParsedWorkflow` and `ProjectMeta`
shape. Branch and path checks for worktree creation are handled by a separate
`checkWorktreeCreation(input, project)` method.

`allowedWorktreeRoots` is supplied by the worktree creation safety input, not by
`ProjectMeta`. An empty `allowedWorktreeRoots` list fails closed.

## Reason

`ParsedWorkflow` does not carry branch or worktree path fields, and `ProjectMeta`
does not currently define worktree roots. Keeping worktree creation safety on a
separate method prevents test-only workflow shapes from becoming an implicit
contract while still enforcing Stage 4 branch/path rules before a worktree is
created.

## Follow-Up Checks

- `pnpm test:unit apps/orchestrator/src/core/approval-gate.test.ts`
- `pnpm lint`
- `pnpm typecheck`
