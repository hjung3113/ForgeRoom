# ForgeRoom — Domain Context

Glossary of domain terms and concepts used in this codebase. Engineering skills
read this file (alongside `Docs/glossary.md`) before exploring or proposing
changes, so the language they produce matches the project's actual vocabulary.

This file is created lazily — entries are added by `/grill-with-docs` (or by
hand) when a term or decision actually gets resolved. Empty sections are fine.

## Core terms

**resume** — Three distinct meanings; never use the bare word alone in design docs:
- *AgentRunner.resume* — same OpenClaw session continuation (output-producing attempt budget retry)
- *PipelineEngine resume* — user-facing `/resume` of a paused task
- *Mastra run resume* — adapter-internal framework-level resume of a Mastra workflow run snapshot (ADR-015 / ADR-017)

**Mastra workflow run** — Mastra-built workflow execution instance. Snapshot is **auxiliary**; TaskStore step rows + `.forgeroom/` files are authoritative (ADR-017).

**DSL→Mastra adapter** — `apps/orchestrator/src/dsl/to-mastra.ts`. Single-responsibility translator: parsed yaml workflow + Intent Catalog → Mastra `createWorkflow()` object (ADR-016). The only place that knows both DSLs.

**pauseAfterGate** — Adapter-inserted Mastra step that follows any DSL step with `pause_after: true`. Hosts the `suspend()` call so Conductor.update is guaranteed to commit before snapshot (ADR-016).

**Selector parser** — ForgeRoom code that interprets `${<step_id>.output.slices}` and `${<step_id>.passed}` from output files. Invoked **inside** the Mastra step body (not by PipelineEngine wrapper), so parsed values flow into Mastra step output and `.dountil()` conditions (ADR-016).
<!--
Notes for editors:
- CONTEXT.md is a glossary, not a spec. Definitions only; implementation
  details belong in Docs/modules/ or Docs/concepts/.
- Cross-link to ADRs and Docs/glossary.md instead of duplicating.
-->


## Cross-references

- `Docs/glossary.md` — canonical term disambiguation
- `Docs/overview.md` — what we're building
- `Docs/architecture.md` — system layout
- `Docs/decisions/` — ADRs
