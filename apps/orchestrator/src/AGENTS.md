---
status: living
last_reviewed: 2026-05-21
---

# apps/orchestrator/src Rules

Read [context-map.md](context-map.md) before starting work in this folder.

## Core rules

1. **Single process.** Do not introduce multi-worker or cluster code (that belongs in Phase 3).
2. **Dependency injection.** Modules receive their dependencies via the constructor. No globals or singletons.
3. **Folder responsibilities are strict:**
   - `core/` — business logic, organized into subfolders (ADR-021): `engine/` (pipeline + step collaborators + PR external effect + output selectors), `agent-runtime/` (agent-runner, agent/harness registries, openclaw-provider), `registries/` (project/workflow/intent config lookup), `conductor/`, `checks/` (check-runner, approval-gate), `reporting/`, `worktree/`, `context/` (forgemap), `effects/` (pull-request-creator). Root keeps `types.ts`, `errors.ts`, `task-store.ts`. Tests stay colocated.
   - `gateway/` — adapters for external surfaces (Discord, GitHub)
   - `dsl/` — workflow yaml → Mastra builder (consumes a resolved workflow; no parsing/semantic-validation of its own)
   - `workflow/` — neutral workflow contract layer (ADR-020): schema/types/expression. Owns the single `ParsedForgeWorkflow`/`ResolvedWorkflow` types, the `source → ParsedForgeWorkflow` parser, and the expression grammar. Imports nothing from sibling folders.
   - `db/` — Drizzle schema, migrations, SQLite binding (the TaskStore implementation)
   - `utils/` — domain-independent helpers only (logger, secret masking, path utils)
4. **`types.ts` convention.** Types that other folders consume go in `<folder>/types.ts`.
5. **Import direction:**
   - Allowed: `gateway → core`, `db → core`
   - Allowed: `core → workflow`, `dsl → workflow`, `db → workflow` (the neutral contract layer; ADR-020)
   - Forbidden: `core → gateway/dsl/db` (dependency inversion violation)
   - Forbidden: `dsl → core` (ADR-020 supersedes the old allowance; dsl gets its schema types from `workflow/`)
   - `workflow` and `utils` may be imported from anywhere, but they themselves import nothing from these folders

## Forbidden

- `console.log` / `console.error` directly — use the project logger
- Reading `process.env.*` directly — go through `config/env.ts` (planned), which validates values
- Crossing folder responsibilities (for example, business logic in `gateway/`)
- Hard-coding worktree paths instead of taking them from env / config
- String-interpolating user input into shell commands

## Pre-PR checklist

- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test:unit` pass (pre-commit enforces this)
- [ ] New modules expose their types through `types.ts`
- [ ] Dependency changes (added/removed) are mentioned in the ADR or PR body
- [ ] Affected `Docs/modules/<name>.md` updated
- [ ] The folder's `context-map.md` "Key files" table is up to date

## Upstream rules

- [Coding rules](../../../Docs/rules/coding-rules.md)
- [Naming rules](../../../Docs/rules/naming-rules.md)
- [Testing rules](../../../Docs/rules/testing-rules.md)
- [Error / retry policy](../../../Docs/policies/error-retry.md)
- [Security policy](../../../Docs/policies/security.md)
