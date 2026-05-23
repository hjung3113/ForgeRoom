# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — domain glossary and concept-level vocabulary.
- **`Docs/glossary.md`** — canonical term disambiguation (`Conductor` vs `Orchestrator`, two meanings of `Phase`, etc.).
- **`Docs/decisions/`** — ADRs that touch the area you're about to work in (path is non-standard; not `docs/adr/`).
- **`Docs/architecture.md`** + relevant **`Docs/modules/<name>.md`** / **`Docs/concepts/<topic>.md`** for system-level context.

If `CONTEXT.md` doesn't exist yet, **proceed silently**. Don't flag its absence; don't suggest creating it upfront. The producer skill (`/grill-with-docs`) creates it lazily when terms or decisions actually get resolved.

## File structure

Single-context repo:

```
/
├── CONTEXT.md                          ← domain glossary (created lazily)
├── Docs/
│   ├── glossary.md                     ← term disambiguation
│   ├── architecture.md
│   ├── decisions/                      ← ADRs (this repo's path; not docs/adr/)
│   │   ├── 2026-05-21-001-runtime-nodejs-typescript.md
│   │   └── ...
│   ├── concepts/
│   ├── modules/
│   ├── policies/
│   └── rules/
└── apps/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md` and `Docs/glossary.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in either glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/grill-with-docs`).

## Flag ADR conflicts

If your output contradicts an existing ADR in `Docs/decisions/`, surface it explicitly rather than silently overriding:

> _Contradicts ADR 2026-05-21-006 (workflow library model) — but worth reopening because…_

Per repo rule: design changes require a new ADR (`proposed` → user approval → `decided`), with impacted docs updated in the same commit.
