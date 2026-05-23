---
status: living
last_reviewed: 2026-05-23
---

# Docs/dev/ Context Map

## Responsibility

Developer-facing guides for local dev tooling — how to run, what each tool shows,
and how it is gated off in production. Not product specs, not ADRs.

## Key files

| File | Role |
|---|---|
| `studio.md` | Mastra Studio dev visualization: launch, what's visible, OQ-M04 trace coverage, navigating to `.forgeroom/` files |

## Related docs

- [ADR-015 — Mastra workflow primitives](../decisions/2026-05-23-015-mastra-workflow-primitives.md) (Studio dev `localhost:4111`, prod default OFF)
- [Open questions — OQ-M04](../open-questions.md) (Studio trace coverage of CLI subprocess I/O)

## Backing code

- `apps/orchestrator/src/mastra/index.ts` — Studio entry (`mastra dev` loads it)
- `apps/orchestrator/src/studio/` — sample workflow + stub agents + production-OFF gate
