---
status: proposed
date: 2026-05-25
issue: "#64"
---

# ADR-026: GitHub Issue Label-Lifecycle as a Terminal Side-Effect

## Background

When ForgeRoom picks up a GitHub issue (via the `ready-for-agent` label poll in
`GitHubIssueTaskSource`), it creates a task with `source = 'github-issue-label'`
and records the triggering `issue_number`. After the task reaches a terminal
state (`done` or `failed`), the original issue label remains `ready-for-agent`
indefinitely — giving the issue tracker a false picture of the task's outcome.

The `GitHubIssueLabelClient` seam already exists in `gateway/github/` to
mutate issue labels, but it was unwired.

This ADR decides how to wire the label-lifecycle transition as a terminal
side-effect.

## Decision

Introduce `IssueLabelLifecycleEffect` in `core/effects/` that applies the
following triage-label transition after a task's terminal status is persisted:

| Terminal status | Remove          | Add              |
|-----------------|-----------------|------------------|
| `done`          | `ready-for-agent` | `ready-for-human` |
| `failed`        | `ready-for-agent` | `needs-info`      |

The effect is called in `PipelineEngine.settle()` immediately after
`updateTaskStatus(...)` for `done` and `failed`. `paused` and `canceled` are
non-terminal and do not trigger label transitions.

**Assumption flagged:** An in-flight agent task is assumed to carry the
`ready-for-agent` label (set by `GitHubIssueTaskSource` when it picks up the
issue). The effect removes it unconditionally. If the label is already absent
(e.g. removed manually), GitHub returns 404, which the failure-isolation wrapper
swallows silently.

### Side-effect only — never owns task state

The label transition is a best-effort external annotation. It MUST NOT:
- Flip the already-settled task status
- Propagate its own errors to the `settle()` call-site

`IssueLabelLifecycleEffect.apply()` catches all port errors internally, logs
them, and always resolves. No typed failure code is associated with label
failures — they are logged as non-fatal.

### No-op when not issue-triggered

When `task.source !== 'github-issue-label'` or `task.issue_number === null`
(Discord-command tasks, or issue-triggered tasks without a recorded number),
`apply()` is a no-op.

### Injected `IssueLabelPort` seam — core stays gateway-free

`core/effects/issue-label-lifecycle.ts` depends on the narrow `IssueLabelPort`
interface:

```ts
interface IssueLabelPort {
  addLabel(args: AddLabelArgs): Promise<void>;
  removeLabel(args: RemoveLabelArgs): Promise<void>;
}
```

`GitHubIssueLabelClient` in `gateway/github/issue-label-client.ts` satisfies
this interface structurally. The concrete adapter is wired in
`app/composition-root.ts` via `buildLabelEffect()`, mirroring the existing
`buildPullRequestEffect()` pattern. Core never imports `GitHubIssueLabelClient`.

### Triage label constants

`apps/orchestrator/src/gateway/github/triage-labels.ts` is the single source of
truth for the five canonical triage label strings defined in
`docs/agents/triage-labels.md`. The effect imports these values through
string literals that match the constants (to avoid a core→gateway import), with
the constants available at the composition-root boundary.

### Composition-root wiring

`buildLabelEffect()` in `composition-root.ts`:
1. Skips if no GitHub credentials are configured (returns `null` effect).
2. Constructs `GitHubIssueLabelClient(octokit)` as the `IssueLabelPort` impl.
3. Constructs `IssueLabelLifecycleEffect({ port, log })`.
4. Returns a `labelTargetFor` resolver (same pattern as `prTargetFor`).
5. Injects `labelEffect` and `labelTargetFor` into `PipelineEngineDeps` (both
   optional — absent when no GitHub is configured).

## Consequences

- The `PipelineEngineDeps` interface gains two optional fields: `labelEffect`
  and `labelTargetFor`. Existing tests need no changes.
- A label port failure no longer affects task-terminal outcomes (consistent with
  ADR-013's "status surface delivery failure does not fail the task" principle).
- The composition root creates one `GitHubIssueLabelClient` shared for both the
  PR effect and the label effect when GitHub is configured.
- Future: if retry/idempotency is needed for label transitions, add it inside
  `IssueLabelLifecycleEffect`, not in `GitHubIssueLabelClient` (consistent with
  the no-retry-in-client rule established for `GitHubIssueLabelClient`).

## References

- ADR-013: TaskSource and Reporter boundaries (task state ownership)
- ADR-019: PR creation as a terminal external effect (pattern mirrored here)
- `docs/agents/triage-labels.md`: canonical triage label strings
- GitHub issue #64
