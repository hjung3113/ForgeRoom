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
   - `core/` — business logic (PipelineEngine, Conductor, AgentRunner, WorktreeManager, CheckRunner, Reporter, ApprovalGate, registries, the TaskStore interface)
   - `gateway/` — adapters for external surfaces (Discord, GitHub)
   - `dsl/` — workflow yaml parsing, variable interpolation, foreach/until evaluation
   - `db/` — Drizzle schema, migrations, SQLite binding (the TaskStore implementation)
   - `utils/` — domain-independent helpers only (logger, secret masking, path utils)
4. **`types.ts` convention.** Types that other folders consume go in `<folder>/types.ts`.
5. **Import direction:**
   - Allowed: `gateway → core`, `dsl → core`, `db → core`
   - Forbidden: `core → gateway/dsl/db` (dependency inversion violation)
   - `utils` may be imported from anywhere, but `utils` itself imports nothing from these folders

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
