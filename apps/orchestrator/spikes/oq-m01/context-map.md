---
status: living
last_reviewed: 2026-05-23
---

# spikes/oq-m01 Context Map

## Responsibility

Throwaway spike resolving OQ-M01: does Mastra `.dountil()` expose a loop
iteration index to the step body, and does the iteration counter survive a
mid-loop suspend/resume? Control-flow only — no LLM.

## Key files

| File | Role |
|---|---|
| `workflow.ts` | Shared `.dountil()` workflow builders (loop + resume variants) |
| `run-loop.ts` | Part A runner: 3-iteration loop, probes for a native index |
| `loop.test.ts` | Part A test: numbering + "no native index in body" |
| `snapshot-io.ts` | Serialize / hydrate a workflow run snapshot via JSON on disk |
| `resume-phase1.ts` / `resume-phase2.ts` | Separate-OS-process resume proof (run under tsx) |
| `resume.test.ts` | Part B test: simulated-restart resume preserves the counter |
| `vitest.config.ts` | Isolated config so spike tests stay out of the main gate |
| `tsconfig.json` | Isolated typecheck for spike code (excluded from `tsconfig.build.json`) |

## Related docs

- Findings: [Docs/spikes/2026-05-23-oq-m01-dountil-iteration.md](../../../../Docs/spikes/2026-05-23-oq-m01-dountil-iteration.md)
- ADR-016: [Docs/decisions/2026-05-23-016-dsl-to-mastra-adapter.md](../../../../Docs/decisions/2026-05-23-016-dsl-to-mastra-adapter.md)

## Entry guide

Run `pnpm -F orchestrator exec vitest run -c spikes/oq-m01/vitest.config.ts`.
This is a spike: read the findings doc, not the code, for the conclusion.
