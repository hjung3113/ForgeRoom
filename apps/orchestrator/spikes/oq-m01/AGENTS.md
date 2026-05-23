# spikes/oq-m01 — Folder Rules

Throwaway OQ-M01 spike. Not production code.

- **Excluded from the main build/gate.** Lives outside `src/`, so
  `tsconfig.build.json` never emits it. Tests run only via the isolated
  `vitest.config.ts` here, not the orchestrator's `unit`/`integration` projects.
- **No LLM.** Plain JS step functions — this probes Mastra control flow, not
  inference.
- **Disposable.** Once OQ-M01 is settled and ADR-016 reflects the finding, this
  folder may be deleted. Do not import spike code from `src/`.
- Keep it runnable: if you touch `workflow.ts`, re-run the isolated vitest config
  and confirm both Part A and Part B still pass.
