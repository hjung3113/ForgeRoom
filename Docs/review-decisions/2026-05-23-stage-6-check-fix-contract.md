---
status: decided
date: 2026-05-23
scope: Stage 6 CheckRunner check-fix contract
---

# Stage 6 Check-Fix Contract

## Decision

Check-fix has a budget of exactly one attempt and is separate from
AgentRunner's output-producing attempt budget.

When initial checks fail, CheckRunner records all command results with
`check_fix_attempt = 0`, writes one addendum prompt at
`.forgeroom/prompts/check_fix_<step_id>.md`, calls `AgentRunner.resume` once,
then reruns all project commands and records new rows with
`check_fix_attempt = 1`.

Check-fix does not create a new workflow step row. The original execute step is
updated:

- `check_status = fixed` when rerun checks pass
- `check_status = failed`, `failure_reason = check_failed_after_fix` when rerun
  checks still fail

On final failure, the task is also marked `failed` with
`failure_reason = check_failed_after_fix`.

Check log artifact paths include `check_fix_attempt` so attempt 0 and attempt 1
rows do not point at overwritten stdout/stderr files.

CheckRunner owns policy and artifact paths, but stdout/stderr tailing and prompt
file writes go through an injected artifact interface. `core/check-runner.ts`
does not call filesystem APIs directly.

## Reason

The one-fix budget needs the full initial failure surface, so CheckRunner runs
all commands before creating the fix prompt. The append-only `checks` rows
preserve both the initial failure and the rerun evidence, while the original
step remains the workflow-level summary.

## Follow-Up Checks

- `pnpm test:unit apps/orchestrator/src/core/check-runner.test.ts`
- `pnpm lint`
- `pnpm typecheck`
