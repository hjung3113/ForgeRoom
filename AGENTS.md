# ForgeRoom — Working Guide

Required reading for anyone (human or agent) working in this repo.

## First-entry order

1. [Docs/overview.md](Docs/overview.md) — what we are building
2. [Docs/architecture.md](Docs/architecture.md) — system layout
3. The relevant [Docs/modules/<name>.md](Docs/modules/) or [Docs/concepts/<topic>.md](Docs/concepts/)
4. The `context-map.md` of the folder you are entering

## Absolute rules

- **Design changes require an ADR.** Anything that affects existing specs goes through ADR `proposed` → user approval → `decided`, with the impacted docs updated in the same commit.
- **No placeholders.** Never leave `TBD` / `TODO` / `fill later` in code or docs.
- **Never commit secrets.** Keep `.env` and similar in `.gitignore`.
- **Never push directly to `main`.** PRs only.
- **Never bypass hooks** (`--no-verify`). If a hook fails, fix the root cause.
- **Keep context bounded.** During doc work, avoid broad raw reads; follow [Docs/rules/doc-rules.md](Docs/rules/doc-rules.md#context-budget).

## Task execution defaults

Applies to every task unless told otherwise:

- **TDD** — failing test first, then implement.
- **Discuss with codex** — grill design/decisions with codex via cmux split pane (not `codex exec`); surface only <80%-confidence items. See [docs/agents/codex-discussion.md](docs/agents/codex-discussion.md).
- **Track via GitHub Issues** — pick up by issue, work the issue, reference it in commits/PR.
- **On completion** — commit, then open a PR (never push to `main`).

## Rule documents (must read)

| Area | File |
|---|---|
| Coding principles | [Docs/rules/coding-rules.md](Docs/rules/coding-rules.md) |
| Naming | [Docs/rules/naming-rules.md](Docs/rules/naming-rules.md) |
| Testing | [Docs/rules/testing-rules.md](Docs/rules/testing-rules.md) |
| Doc workflow | [Docs/rules/doc-rules.md](Docs/rules/doc-rules.md) |
| Git / commits / PRs | [Docs/rules/git-rules.md](Docs/rules/git-rules.md) |
| Context map convention | [Docs/rules/context-map-rules.md](Docs/rules/context-map-rules.md) |

## Folder convention

- Every code folder has both `AGENTS.md` (folder-scoped rules) and `context-map.md` (folder guide).
- When you create a new folder, create both files at the same time.

## Key decisions (canonical source: ADRs)

- Runtime: Node.js + TypeScript
- Storage: SQLite + Drizzle
- Agent execution: through AgentRuntimeProvider; MVP provider is OpenClawProvider
- Prompt passing: file-based (under worktree `.forgeroom/`)
- Conductor meta-agent (option B: headless + rolling summary)
- Workflows are a library; chosen at invocation time
- Desktop app and Tailscale: Phase 3
- Phase 1 MVP scope: [Docs/phases/phase-1-mvp.md](Docs/phases/phase-1-mvp.md)

## Open items

[Docs/open-questions.md](Docs/open-questions.md) — unresolved decisions and items to verify

## Term disambiguation

Check [Docs/glossary.md](Docs/glossary.md) before assuming. Pay special attention to `Conductor` vs `Orchestrator` and the two meanings of `Phase`.

## Agent skills

### Issue tracker

GitHub Issues on `hjung3113/ForgeRoom` via `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles with default strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — `CONTEXT.md` at repo root; ADRs at `Docs/decisions/` (non-standard path, not `docs/adr/`). See `docs/agents/domain.md`.

## Working loop (humans and agents)

1. Read the plan or task
2. Read the entry folder's `context-map.md` then `AGENTS.md`
3. Read the matching module spec and concept doc
4. Write tests first, or alongside the implementation
5. Implement
6. Run lint + typecheck + tests (the pre-commit hook enforces this)
7. Commit (one task ≈ one commit)
8. Update the docs you affected
9. Open a PR
