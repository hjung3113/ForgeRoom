---
status: living
last_reviewed: 2026-05-21
---

# utils/ Rules

Read [context-map.md](context-map.md) first.

## Core rules

1. **Domain-independent only.** No ForgeRoom domain concepts. Pure helpers anyone could borrow.
2. **No imports from sibling folders.** `utils` only exports; it never depends on `core`, `gateway`, `dsl`, or `db`.
3. **Minimal side effects.** Prefer pure functions.
4. **Logger and secret masking live here.** Any folder can import them safely.
5. **Unit-test everything.** Small helpers still get tests.

## Files (planned)

- `logger.ts` — pino-based JSON logger
- `secret-mask.ts` — token pattern masking
- `paths.ts` — worktree-internal path builders (prompts/outputs/diffs)
- `env.ts` — environment variable schema and validation
- `errors.ts` — base error class (`OrchestratorError`)
- `time.ts` — duration / sleep / AbortController helpers as needed

## Forbidden

- Business logic (no dependency on `Task`, `Workflow`, `Step`, etc.)
- External IO (DB, filesystem) — except `logger` writing to stdout / a log file
- Importing from any other `src/` folder

## Checklist

- [ ] No imports from sibling folders
- [ ] Unit tests in place
- [ ] No domain dependencies

## Upstream rules

- [src/CLAUDE.md](../CLAUDE.md)
- [Coding rules](../../../../Docs/rules/coding-rules.md)
