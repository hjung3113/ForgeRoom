---
status: living
last_reviewed: 2026-05-21
---

# gateway/ Context Map

## Responsibility

Adapters for the external surfaces (Discord, GitHub). Receive and validate external input, route into `core`, and send outbound API calls.

## Key files (planned)

| File | Role | Spec |
|---|---|---|
| `discord-gateway.ts` | Slash command intake, allowlist, routing into `core` | [Docs/modules/discord-gateway.md](../../../../Docs/modules/discord-gateway.md) |
| `github-gateway.ts` | Issue label polling, PR creation | [Docs/modules/github-gateway.md](../../../../Docs/modules/github-gateway.md) |
| `types.ts` | Exported gateway types | — |

## Related docs

- [Discord Gateway spec](../../../../Docs/modules/discord-gateway.md)
- [GitHub Gateway spec](../../../../Docs/modules/github-gateway.md)
- [Reporter (response delivery)](../../../../Docs/modules/reporter.md)
- [Security policy](../../../../Docs/policies/security.md)

## Dependencies

- External: `discord.js`, `@octokit/rest`
- Internal: `core/` (PipelineEngine, Reporter, Conductor)

## Entry guide

1. Read the spec's list of commands and events
2. Wrap the SDK behind an interface so it can be injected (and mocked) by `core`
3. Apply the allowlist before doing anything else
