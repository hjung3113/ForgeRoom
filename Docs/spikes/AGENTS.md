# Docs/spikes — Folder Rules

Findings docs for time-boxed spikes that resolve Open Questions.

- One doc per spike, named `YYYY-MM-DD-<oq-id>-<slug>.md`, with front-matter
  `status`, `date`, `question`, and any version pin used.
- State the **outcome first**. A spike answers a question; do not bury it.
- A spike that contradicts a `decided` ADR is a **design change**: propose the
  ADR amendment (do not edit the ADR silently) and link it from the spike doc.
- Always update the matching `Docs/open-questions.md` entry to `resolved` and
  cite the spike commit/PR.
- The throwaway code lives elsewhere (e.g. `apps/orchestrator/spikes/`); link it,
  do not copy it here.
