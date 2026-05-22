---
status: decided
date: 2026-05-23
scope: Stage 4 WorktreeManager bootstrap
---

# Stage 4 Worktree Bootstrap Boundary

## Decision

Stage 4 `WorktreeManager` bootstraps only the base prompt-file protocol
directories and context files:

- `.forgeroom/context/task.md`
- `.forgeroom/context/summary.md`
- `.forgeroom/context/workflow.md`
- `.forgeroom/context/feedback.md`
- `.forgeroom/context/docs/`
- `.forgeroom/prompts/`
- `.forgeroom/outputs/`
- `.forgeroom/diffs/`
- `.forgeroom/logs/`

ForgeMap staging files such as `selected-forgemap.md`,
`target-profile.md`, and copied source docs remain Stage 8 responsibility.

## Reason

`WorktreeManager` owns safe worktree and artifact directory bootstrap. ForgeMap
selection and source document staging require project-context decisions owned by
Stage 8, so Stage 4 must not create placeholder ForgeMap artifacts.

## Follow-Up Checks

- `pnpm test:unit apps/orchestrator/src/core/worktree-manager.test.ts`
- `pnpm lint`
- `pnpm typecheck`
