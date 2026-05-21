---
status: living
last_reviewed: 2026-05-21
---

# apps/orchestrator/src Context Map

## Responsibility

All code for the single-process ForgeRoom orchestrator: Discord and GitHub gateways, workflow DSL evaluation, agent invocation, task state management, and PR creation.

## Layout

```
src/
├── core/        # business logic (engine, conductor, registries, task-store interface)
├── gateway/     # adapters for Discord and GitHub
├── dsl/         # workflow yaml parser, variable interpolation
├── db/          # Drizzle schema, migrations, SQLite (TaskStore implementation)
├── utils/       # domain-independent helpers (logger, secret-mask, path utils)
└── index.ts     # entry point (planned)
```

Each folder has its own `context-map.md` and `CLAUDE.md`.

## Import direction

```
gateway ──┐
dsl     ──┼──▶ core ──▶ utils
db      ──┘
```

- `core` never imports from sibling folders
- `utils` is one-way (consumed, not consuming)

## Related docs

- Top-level entry: [Docs/overview.md](../../../Docs/overview.md)
- Architecture: [Docs/architecture.md](../../../Docs/architecture.md)
- Phase 1 scope: [Docs/phases/phase-1-mvp.md](../../../Docs/phases/phase-1-mvp.md)
- Module specs: [Docs/modules/](../../../Docs/modules/)
- Data model: [Docs/concepts/data-model.md](../../../Docs/concepts/data-model.md)
- Workflow DSL: [Docs/concepts/workflow-dsl.md](../../../Docs/concepts/workflow-dsl.md)
- Prompt protocol: [Docs/concepts/prompt-file-protocol.md](../../../Docs/concepts/prompt-file-protocol.md)

## Runtime dependencies

- Node.js ≥ 20
- TypeScript ≥ 5
- Planned packages: `better-sqlite3`, `drizzle-orm`, `discord.js`, `@octokit/rest`, `yaml`, `zod`, `pino`, `node-pty` (optional)

## Entry guide

1. Read the matching module spec under `Docs/modules/<name>.md`
2. Enter the folder you will work in and read `context-map.md` then `CLAUDE.md`
3. Inspect the exposed types in `types.ts`
4. Read existing tests first to understand expected behavior
