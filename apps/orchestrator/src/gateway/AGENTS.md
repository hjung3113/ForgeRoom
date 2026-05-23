---
status: living
last_reviewed: 2026-05-21
---

# gateway/ Rules

Read [context-map.md](context-map.md) first.

## Core rules

1. **Stay a thin adapter.** Translate between external SDKs (discord.js, Octokit) and `core`. No business logic.
2. **All external IO lives here.** `core` must not import `discord.js` or `Octokit` directly.
3. **Validate and sanitize input.** Commands, issue bodies, and other external input get validated here before reaching `core`.
4. **Apply allowlists here.** Discord user-id checks and GitHub repo registration checks happen at the gateway boundary.
5. **Retries and backoff live here.** API failure handling stays in the adapter so `core` calls remain clean.

## Files

- `discord-gateway.ts`
- `github-gateway.ts`
- `clients/` (sub-folder, if needed): SDK wrappers

## Forbidden

- Workflow evaluation or step execution logic (those belong in `core`)
- Direct TaskStore access (go through `core` APIs like `PipelineEngine`)
- Logging secrets

## Checklist

- [ ] Only `core` modules called from here (not `TaskStore` directly)
- [ ] Input validation and allowlists applied
- [ ] API errors converted to domain errors
- [ ] SDK clients injected via constructor for testability

## Upstream rules

- [src/AGENTS.md](../AGENTS.md)
- [Security policy](../../../../Docs/policies/security.md)
