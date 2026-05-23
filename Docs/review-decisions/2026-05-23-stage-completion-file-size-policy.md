---
status: decided
date: 2026-05-23
scope: Stage completion refactor policy
---

# Stage Completion File Size Policy

## Decision

At the end of every implementation stage, files over 300 lines must be reviewed
for role separation and refactored before the stage is marked complete.

Tests and implementation content should be separated when a test file grows past
that threshold. Test-only fakes, builders, and fixtures belong in a dedicated
test-support area, while production implementation stays in its module file.

## Reason

Large files make later agent review and continuation harder. Stage completion is
the natural checkpoint to split responsibilities before the next stage builds on
the current module.

## Follow-Up Checks

- Run `wc -l` on files touched in the stage before marking the stage complete.
- Keep production modules and test-support helpers in separate roles.
