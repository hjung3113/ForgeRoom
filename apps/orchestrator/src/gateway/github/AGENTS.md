---
status: living
last_reviewed: 2026-05-25
---

# gateway/github/ Rules

Read [context-map.md](context-map.md) first.

## Scope

GitHub-specific gateway adapters only. Keep this folder thin: translate between
Octokit-shaped calls and ForgeRoom core interfaces.

## Allowed

- GitHub issue polling and issue-to-task intake mapping
- GitHub pull request API primitives
- GitHub-specific adapter types and injectable Octokit surfaces

## Forbidden

- Workflow evaluation, task settling, or retry/idempotency orchestration
- Direct TaskStore access
- Business rules that belong in `core`

## Upstream Rules

- [gateway/AGENTS.md](../AGENTS.md)
- [src/AGENTS.md](../../AGENTS.md)
