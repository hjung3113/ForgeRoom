---
status: living
last_reviewed: 2026-05-23
---

# Mastra Studio (local dev visualization)

Studio is a **dev-only** surface for visualizing ForgeRoom workflows as a graph,
stepping through runs, and inspecting per-step input/output and traces. It is
**OFF by default** and never auto-starts in production (ADR-015).

## Launch

```bash
pnpm -F orchestrator dev:studio
```

This runs `FORGEROOM_STUDIO=1 mastra dev --dir src/mastra` and serves Studio at
**http://localhost:4111** (API at `http://localhost:4111/api`). The script is the
only place that invokes `mastra dev`; production start scripts never call it.

The Studio entry is `apps/orchestrator/src/mastra/index.ts`, which `mastra dev`
discovers and reads its exported `mastra` const from. The entry registers a
self-contained **sample workflow** (the `full` workflow with STUB agents — no
real LLM, no OpenClaw CLI subprocess), so a run completes deterministically and
renders a full trace with zero external dependencies.

### Production-OFF gate

Two independent guards keep Studio out of production:

1. **Launch gate** (`src/studio/gate.ts`, `isStudioEnabled`): the entry registers
   the sample workflow only when `FORGEROOM_STUDIO` is a recognised truthy value
   (`1`/`true`/`yes`/`on`). Absent the flag — the production default — the entry
   exports an **empty** Mastra instance, so even if a prod process loaded it,
   Studio would show nothing. Covered by `src/studio/gate.test.ts` and
   `src/mastra/index.test.ts`.
2. **Script gate**: only `dev:studio` invokes `mastra dev`. Production never does.

> Why not gate on `NODE_ENV=production`? `mastra dev` itself sets
> `NODE_ENV=production` for its bundle step, so NODE_ENV is unusable as a guard
> here. Protection lives at the explicit-opt-in flag + the launch boundary
> (codex confidence 92 on "gate the launch, not the runtime config").

## What's visible in Studio

For the sample `full` workflow, Studio renders:

- **Workflow graph** — the full step shape: `impl_plan` → `impl_plan_refine` →
  `slices` foreach (`slices:items` / `slices:item`) → `final_quality` review_loop
  (`final_review` / `final_refine`). Verified: `GET /api/workflows/full` returns
  every step with its input/output JSON schema.
- **Step inspector** — per-step input and structured output. The sample's stub
  steps emit the real `StepExecution` contract shape
  (`{ stepId, outputPath, diffPath, iteration, passed, slices }`), e.g.
  `impl_plan` outputs `outputPath: ".forgeroom/outputs/impl_plan.md"`.
- **Trace timeline** — per-step `startedAt`/`endedAt` timing and run status.
  Verified: triggering a run via the Studio API produced a run snapshot with
  `status: "success"` and per-step timing + output records.
- **Token usage** — for real LLM/agent/model spans, Studio shows token usage.
  The sample uses stub agents, so it has no token usage to show; this column is
  populated only when a step drives a real model through Mastra.

## What's NOT visible (OQ-M04)

**Studio traces step boundaries only — it does NOT capture the OpenClaw CLI
subprocess stdout/stderr.** Mastra's tracing model records span input/output,
timing, and token usage at step/agent/tool/model boundaries. In ForgeRoom, the
external coding agent runs inside the step body via `OpenClawProvider`, which
redirects the subprocess `stdout`/`stderr` to files
(`stdoutPath`/`stderrPath` → `.forgeroom/logs/`). Those bytes never enter
Mastra; only the **structured result** the step body returns (output text and
`.forgeroom/` path references) appears in the trace.

So:

- **In Studio**: which step ran, when, its input refs, its structured output,
  pass/fail, slices, and the `.forgeroom/` paths it produced.
- **NOT in Studio**: the full raw stdout/stderr of the agent CLI process. Read
  those in `.forgeroom/<task>/logs/NN_<step>.{stdout,stderr}`.

(OQ-M04 resolved: codex confidence 88 + Mastra observability docs + empirical run
snapshot. See `Docs/open-questions.md`.)

## Navigating from a Studio step to `.forgeroom/<task>/` files

Every executable step's inspector output carries the `.forgeroom/`-relative paths
the real PipelineEngine writes. To go from a Studio step to the on-disk
artifacts of a real task:

1. Find the task's worktree path (from the task row / `worktree_path`). All paths
   below are relative to `<worktree>/.forgeroom/`.
2. The step's file base is `NN_<step_id>` (a monotonic 2-digit index assigned in
   declaration order, e.g. `01_impl_plan`, `02_impl_plan_refine`).
3. From a step you can open, under `<worktree>/.forgeroom/`:
   - `prompts/NN_<step_id>.md` — the rendered prompt the agent received
   - `outputs/NN_<step_id>.md` — the agent's saved output (shown as `outputPath`)
   - `diffs/NN_<step_id>.diff` — the diff, when the step produced one (`diffPath`)
   - `logs/NN_<step_id>.stdout` / `.stderr` — the raw CLI subprocess streams
     (the part Studio does NOT show — this is where you debug the agent process)

So a Studio step inspector tells you *what* the step produced and *where*; the
`.forgeroom/logs/` files tell you *how the CLI got there*.

## Verified vs manual

Programmatically verified in this repo (non-interactive):

- `mastra dev` starts, binds `localhost:4111`, returns HTTP 200.
- With `FORGEROOM_STUDIO=1`, `GET /api/workflows` registers `full` with all steps
  and their input/output schemas; without the flag, no workflow is registered.
- A run triggered via the Studio API completes `success` and persists a run
  snapshot with per-step timing + structured output.

Requires a human looking at the Studio UI (cannot be asserted headlessly):

- The exact rendered look of the graph view and the step-inspector panel.
- That the trace timeline visualizes the recorded spans as expected in the UI.

Version note: `mastra` CLI `1.10.0` (peer `@mastra/core >=1.34.0-0 <2.0.0-0`)
against `@mastra/core` `1.36.0` — within the advertised peer range, but pinned
exact; smoke-test `dev:studio` on any `@mastra/*` bump (OQ-M03).
