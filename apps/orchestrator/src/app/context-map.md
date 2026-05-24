---
status: living
last_reviewed: 2026-05-23
---

# app/ Context Map

## Responsibility

The orchestrator composition root (#30). Loads config + env, instantiates every
`core` module and `gateway` adapter with real implementations, runs the boot
lifecycle (`recoverPending()` then start the TaskSources), and exposes a single
runnable entry (`main.ts`).

## Key files

| File | Role | Spec |
|---|---|---|
| `config.ts` | `configs/*.yaml` → registries; env → `OrchestratorEnv` (isolated env loading) | [Docs/phases/phase-1-mvp.md](../../../../Docs/phases/phase-1-mvp.md) |
| `composition-root.ts` | `composeOrchestrator()` → `OrchestratorApp.boot()` | ADR-012, ADR-013, ADR-015, ADR-019 |
| `git-cli.ts` | Shared Git CLI primitive adapter for app-level git integrations | — |
| `gateway-port.ts` | `OrchestratorGatewayPort` facade over PipelineEngine / Conductor / TaskStore | [Docs/modules/discord-gateway.md](../../../../Docs/modules/discord-gateway.md) |
| `openclaw-ipc.ts` | Boot OpenClaw IPC client (real subprocess: #31) | [ADR-012](../../../../Docs/decisions/2026-05-22-012-agent-runtime-provider-boundary.md) |
| `worktree-adapters.ts` | Git-CLI worktree client + node-fs file system | [Docs/modules/worktree-manager.md](../../../../Docs/modules/worktree-manager.md) |
| `worktree-naming.ts` | Branch + worktree path naming | — |
| `forgemap-adapters.ts` | Repo probe + task lookup + bootstrap forgemap store | [Docs/modules/forgemap.md](../../../../Docs/modules/forgemap.md) |

`../main.ts` is the runnable entry (`pnpm -F orchestrator start`).

## Boot lifecycle

1. `loadRegistries()` + `resolveEnv()` (config.ts).
2. open SQLite TaskStore, run migrations.
3. `composeOrchestrator()` wires everything (ApprovalGate placed BOTH pre-Mastra
   in `runFull` and in-step in the adapter body).
4. `app.boot()` → `reporter.flushUndelivered()` → `engine.recoverPending()` →
   start DiscordGateway + GitHubIssueTaskSource (gated on credentials).

Studio (`mastra dev`) is never started by this path (ADR-015).

## Dependencies

- Internal: `core/` (every module), `gateway/`, `db/`, `dsl/`, `utils/`.
- External: `yaml` (config), `better-sqlite3`/`drizzle-orm` (store), `discord.js`,
  `octokit`, `@mastra/core` (per-run, built by the engine).

## What lives elsewhere

- Workflow/step/check logic → `core/`.
- SDK transport details → `gateway/` adapters (this folder only constructs them).
- Real OpenClaw subprocess → #31.
