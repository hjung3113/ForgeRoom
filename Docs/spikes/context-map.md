---
status: living
last_reviewed: 2026-05-23
---

# Docs/spikes Context Map

## Responsibility

Findings from time-boxed technical spikes that resolve Open Questions (OQ-*).
Each spike doc records the question, the empirical method, and the outcome, and
references the throwaway spike code that produced it.

## Key files

| File | Role |
|---|---|
| `2026-05-23-oq-m01-dountil-iteration.md` | OQ-M01: Mastra `.dountil()` iteration index + resume |
| `2026-05-23-oq-m02-foreach-suspend.md` | OQ-M02: Mastra `.foreach()` mid-iteration suspend/resume |

## Related docs

- [Docs/open-questions.md](../open-questions.md) — the OQ register a spike resolves
- [Docs/decisions/](../decisions/) — ADRs a spike may amend

## Entry guide

Name new spike docs `YYYY-MM-DD-<oq-id>-<slug>.md`. State the outcome up front,
link the spike code, and update the matching OQ entry to `resolved`.
