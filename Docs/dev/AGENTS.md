# Docs/dev — Folder Rules

Developer-facing operational docs for local dev tooling (not product specs).

- One doc per tool/workflow, named for the tool (e.g. `studio.md`).
- State the launch command and the OFF-by-default posture first.
- Describe what the tool DOES and DOES NOT show; never overstate visibility.
- Dev tooling must be production-OFF by default; document the opt-in gate.
- Link to the code that backs the doc (e.g. `apps/orchestrator/src/studio/`),
  do not duplicate it here.
- A doc here is not an ADR. Design decisions still go through `Docs/decisions/`.
