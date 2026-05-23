---
status: resolved
date: 2026-05-23
question: OQ-M01
mastra_version: "@mastra/core 1.36.0"
---

# Spike: Mastra `.dountil()` iteration index (OQ-M01)

## Question

Does Mastra `.dountil()` / `.dowhile()` expose a loop ITERATION INDEX to the loop
step's `execute` body? ForgeRoom's `review_loop` needs per-iteration numbering
(step rows carry `iteration=0,1,2`; prompt/output files named
`NN_<step_id>.<iteration>.md`, e.g. `07_slice_review.0.md`).

## Outcome: (b) — no native index in the step body; manual threading works

**Mastra exposes the iteration counter ONLY in the loop condition predicate, not
in the step `execute` body.** ForgeRoom's adapter must thread the iteration index
through step input/output, exactly as ADR-016 already assumed. The spike confirms
manual threading works end-to-end, including a mid-loop suspend/resume.

### Evidence — type surface (`@mastra/core/dist/workflows/step.d.ts`)

- `LoopConditionFunction = ConditionFunctionParams & { iterationCount: number }`
  — the `.dountil()` / `.dowhile()` condition receives `iterationCount`.
- `ExecuteFunctionParams` (the step body) has NO `iterationCount`. It exposes
  `inputData`, `state` / `setState`, `resumeData`, `suspend`, `getStepResult`,
  `getInitData`, `retryCount`, etc. — but no loop index.

### Evidence — runtime probe (`spikes/oq-m01/`)

- `loop.test.ts`: a real `.dountil()` workflow runs 3 iterations. The step body
  scans every enumerable key on its execute context for anything matching
  `/iteration|loopindex|loopcount/i` → **none found**. (The runtime probe only
  sees enumerable string keys; the authoritative gap-closer is the `.d.ts` type
  surface above, which has no such field, enumerable or otherwise. A codex
  source review of `executeStep()` independently confirmed `iterationCount` is
  kept in internal step-result metadata and never injected into the
  `step.execute()` payload, `getStepResult()`, or `requestContext`.) The threaded
  `inputData.iteration` is the only counter available, and it correctly produces
  files `07_slice_review.0.md`, `.1.md`, `.2.md`.
- `resume.test.ts`: the loop suspends mid-iteration (iteration 1), the snapshot is
  serialized to disk, a **brand-new** `InMemoryStore` + `Mastra` + workflow are
  built and hydrated from that JSON only, the run is recreated by its persisted
  `runId`, and `run.resume()` continues from iteration 1 and finishes all 3. The
  threaded counter survives the restart and numbering stays monotonic.
- `resume-phase1.ts` / `resume-phase2.ts`: the same proof across **two separate
  OS processes** (run under `tsx`). Phase 1 suspends and exits; phase 2 (fresh
  PID) resumes the same `runId` and completes — producing all three numbered
  files. Verified manually during the spike.

## Implication for the adapter (ADR-016)

The existing ADR-016 "iteration 인덱스 (review_loop)" decision is **correct as
written**: the adapter threads `{iteration, passed, prevOutputPath}` through the
loop step's input/output. The only update is to remove the uncertainty caveat —
the spike has now confirmed empirically (was confidence 78). The native
`iterationCount` in the condition is still useful purely as a hard loop ceiling
(safety against runaway loops), independent of ForgeRoom's own iteration number.

### Threading vehicle choice

Two viable vehicles exist; ADR-016 picks step input/output (not `state`):

- **input/output (chosen):** `iteration` rides in the loop step's schema. The
  `.dountil()` condition reads `inputData.passed` — already required by ADR-016's
  output-selector decision — so co-locating `iteration` there keeps one data path.
- **`setState`/`state`:** also survives suspend/resume, but splits loop bookkeeping
  across a second channel and is not needed.

## How to run

```bash
pnpm -F orchestrator exec vitest run -c spikes/oq-m01/vitest.config.ts
# separate-process variant:
node <tsx-cli> spikes/oq-m01/resume-phase1.ts <outDir> <snapshot.json>
node <tsx-cli> spikes/oq-m01/resume-phase2.ts <outDir> <snapshot.json>
```

Spike code lives under `spikes/` (outside `src/`), so it is excluded from
`tsconfig.build.json` and never emitted to `dist/`.

## Caveats

- Version-specific to `@mastra/core@1.36.0`. The conclusion holds while the
  version is pinned; re-verify on upgrade (tracked by OQ-M03).
- `.dowhile()` was not separately exercised. It shares the loop executor and the
  same `LoopConditionFunction` type, so the conclusion applies; a follow-up probe
  is cheap if ForgeRoom adds a `.dowhile()` lowering.
- Durable store adapters (LibSQL/Postgres) were not tested directly; the spike
  exercises the same `persistWorkflowSnapshot` / `loadWorkflowSnapshot` contract.
