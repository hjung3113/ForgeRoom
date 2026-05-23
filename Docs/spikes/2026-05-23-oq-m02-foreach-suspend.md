# Spike: OQ-M02 — Mastra `.foreach()` mid-iteration suspend/resume

- Date: 2026-05-23
- Resolves: OQ-M02 (`Docs/open-questions.md`)
- Amends: ADR-016 (`Docs/decisions/2026-05-23-016-dsl-to-mastra-adapter.md`), foreach + `pause_after` section
- Experiment code: `apps/orchestrator/spikes/oq-m02/foreach-suspend.spike.ts`
- Mastra: `@mastra/core` 1.36.0

## Question

ForgeRoom's DSL allows `pause_after: true` on any executable step, including a
step nested inside a `foreach` group (slice-impl). ADR-016 deferred this:
can a step inside Mastra `.foreach()` call `suspend()` mid-iteration and
`resume()` to the SAME iteration — not restart the loop, not skip the item?

## Method

A real Mastra workflow, plain JS step functions (no LLM/model):

```
createWorkflow({ inputSchema: z.array(item) })
  .foreach(handleItem)   // default concurrency 1 (sequential)
  .commit()
```

`handleItem` has `resumeSchema {approved}` + `suspendSchema`. It calls
`suspend()` for any item not yet approved, and pushes the item name to a
module-level `processed[]` array only when it completes. Input is three items:
`a`(approved), `b`(NOT approved), `c`(approved). So iteration index 1 (`b`)
suspends.

Detection logic: if `.foreach()` restarted the loop on resume, `a` would be
re-executed and `processed` would contain `a` twice. If it skipped `b`, `b`
would be absent. A clean mid-iteration resume yields each item exactly once.

A `MockStore` is configured as Mastra `storage` — required so the suspend
snapshot persists between `run.start()` and `run.resume()`.

Run: `node --experimental-strip-types spikes/oq-m02/foreach-suspend.spike.ts`
(from `apps/orchestrator`).

## Result (observed, runnable)

```
after start:  status = suspended
processed after start:  ["a"]
suspended steps: [["handle-item"]]
after resume: status = success
processed after resume: ["a","b","c"]
CLEAN_MID_ITERATION_RESUME = true
```

Per-iteration step records: `a` success, `b` suspended → resumed → success,
`c` success. Each item processed exactly once, in order. The loop did NOT
restart and did NOT skip the suspended item.

## Decision — Outcome (a): NATIVE

Mastra `.foreach()` (sequential, `concurrency: 1`) natively supports clean
mid-iteration `suspend()` / `resume()`. The workflow snapshot captures the
in-loop position and resume continues from the suspended iteration.

Therefore:

- No adapter lowering of `foreach` to an explicit sequential chain is needed.
- No DSL restriction on `pause_after` inside `foreach` is needed.
- `workflow-registry.ts` validation is unchanged.

### Required condition

Suspend/resume requires a persistent snapshot store on the Mastra instance.
Without `storage`, `run.resume()` throws `No snapshot found for this workflow
run`. ForgeRoom already configures storage (SQLite/Drizzle per project
decisions; ADR-017 treats TaskStore as authority, Mastra snapshot as
auxiliary), so this condition is satisfied in production.

## Caveat (not proven by this spike)

This proves the MVP shape: `.foreach()` with `concurrency: 1` (sequential per
item — exactly what ADR-016 specifies for MVP). With `concurrency > 1`,
multiple iterations can be in-flight/suspended simultaneously and all suspended
points report the same step id (`handle-item`), so resume targeting per
iteration is not proven here. MVP uses sequential foreach, so this is out of
scope; if a future workflow needs parallel foreach with per-item pauses, it
must be re-spiked for stable per-iteration resume identity.

## Codex review

Grilled via `codex exec`. Verdict: outcome (a) NATIVE, confidence 84/100.
Confirmed the restart-detection reasoning is sound (restart would yield
`["a","a","b","c"]`) and that the concurrency>1 case is a genuine open caveat,
not an MVP blocker. >=80 so resolved without escalation.
