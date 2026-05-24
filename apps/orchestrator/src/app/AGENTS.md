---
status: living
last_reviewed: 2026-05-23
---

# app/ Rules

Read [context-map.md](context-map.md) before editing this folder.

## Core rules

1. **This is the composition root.** It is the ONE place that loads `configs/*.yaml` and reads `process.env` (via `config.ts`). No other folder touches `process.env`; everything downstream receives validated config by constructor injection.
2. **Wiring only, no business logic.** `app/` assembles `core` modules and `gateway` adapters; it must not contain workflow/step/check logic (that lives in `core`). Thin glue adapters (worktree git CLI, forgemap probe, gateway-port facade) are allowed because they are pure wiring.
3. **External-I/O adapters are overridable.** Discord/GitHub/OpenClaw adapters are built from env by default but can be replaced via `ExternalAdapterOverrides` so the boot integration test runs with fakes (no live credentials).
4. **Studio is never launched here.** Production boot must not start `mastra dev` (ADR-015). The boot path refuses to start when `FORGEROOM_STUDIO` is set.
5. **Boot lifecycle is explicit:** compose (sync) → `flushUndelivered()` + `recoverPending()` → start TaskSources (gated on credentials / `startSources`).

## Forbidden

- `console.log` / `console.error` directly — inject a `log` sink (defaults to stderr/stdout in `main.ts`).
- Reading `process.env` outside `config.ts`.
- Crossing into `core` business logic.

## Files

| File | Role |
|---|---|
| `config.ts` | Load + validate `configs/*.yaml` into registries; resolve runtime env (the isolated env place) |
| `composition-root.ts` | `composeOrchestrator()` — wire every module into an `OrchestratorApp` with a `boot()` lifecycle |
| `conductor-git.ts` | Git-backed Conductor scope-guard adapter |
| `git-cli.ts` | Shared Git CLI primitive adapter for app-level git integrations |
| `gateway-port.ts` | `OrchestratorGatewayPort` facade (maps slash commands / issue tasks onto PipelineEngine / Conductor / TaskStore) |
| `openclaw-ipc.ts` | Real OpenClaw IPC client — spawns the OpenClaw CLI subprocess, streams logs, parses the session marker, maps outcomes to `failureKind` (#31). See `Docs/dev/openclaw-e2e.md` |
| `worktree-adapters.ts` | Git-CLI `WorktreeGitClient` + node-fs `WorktreeFileSystem` |
| `worktree-naming.ts` | Branch + worktree path naming (encodes project id in the path) |
| `forgemap-adapters.ts` | Git `RepoStateProbe`, SQLite `TaskContextLookup`, `BootstrapForgeMapStore` |

## Upstream rules

- [src/AGENTS.md](../AGENTS.md)
- [Coding rules](../../../../Docs/rules/coding-rules.md)
- [Security policy](../../../../Docs/policies/security.md)
