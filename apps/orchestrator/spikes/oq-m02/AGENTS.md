# spikes/oq-m02 — Working Guide

Throwaway spike code. NOT production. Lives outside `src/`, so excluded from
`tsconfig.build.json` (build emits `src/` only).

- Resolves OQ-M02: Mastra `.foreach()` mid-iteration suspend/resume.
- Run: `node --experimental-strip-types spikes/oq-m02/foreach-suspend.spike.ts` from `apps/orchestrator`.
- Findings: `Docs/spikes/2026-05-23-oq-m02-foreach-suspend.md`.
