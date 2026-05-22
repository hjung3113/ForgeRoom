---
status: decided
date: 2026-05-23
scope: Stage 6 command-runner utility boundary
---

# Stage 6 CommandRunner Utility Boundary

## Decision

`command-runner.ts` lives in `apps/orchestrator/src/utils` as the Node command
execution adapter for ForgeRoom-owned check commands.

This is a narrow exception to the utils folder's usual no-filesystem-IO rule:
`command-runner.ts` may create directories and write the caller-provided
stdout/stderr artifact files. It must not import ForgeRoom domain types or
decide check status.

Core `CheckRunner` consumes the `CommandRunner` interface and remains free of
`child_process` calls.

## Reason

Stage 6 requires child process execution to stay out of `core`, while
CheckRunner needs deterministic stdout/stderr artifacts for project verification
commands. Keeping the adapter in `utils` preserves the existing import direction
and keeps the domain decision in `core`.

Shell command strings are accepted by this adapter only after upstream
`ApprovalGate.checkCommand` approval.

## Follow-Up Checks

- `pnpm test:unit apps/orchestrator/src/utils/command-runner.test.ts`
- `pnpm lint`
- `pnpm typecheck`
