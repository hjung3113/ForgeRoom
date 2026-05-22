---
status: decided
date: 2026-05-23
scope: Stage 3 TaskStore completion review
---

# Stage 3 TaskStore Completion

## Decisions

- `failure_reason` persistence accepts only the MVP canonical values listed in
  `Docs/concepts/data-model.md`.
- `upsertConductorState` preserves the existing `last_step_id` when callers omit
  `lastStepId`; callers pass `null` only when they intentionally clear it.
- Stage 3 keeps the named integration target
  `tests/integration/task-store-locks.test.ts` so lock behavior is verified
  outside the unit file.

## Reason

These points were settled during Stage 3 adversarial review after the initial
conductor state implementation. They prevent later agents from reopening whether
canonical failure reasons are merely round-tripped, whether summary-only
conductor updates clear the last step, or whether the integration test named in
the implementation plan can be skipped.

## Follow-Up Checks

- `pnpm test:unit apps/orchestrator/src/db/sqlite-task-store.test.ts`
- `pnpm test:integration`
- `pnpm lint`
- `pnpm typecheck`
