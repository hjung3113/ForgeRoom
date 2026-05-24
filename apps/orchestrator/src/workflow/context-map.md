---
status: living
last_reviewed: 2026-05-25
---

# workflow/ Context Map

## Responsibility

Neutral workflow contract layer from ADR-020. This folder owns shared workflow
types used by `core/` and `dsl/` without either folder importing from the other.

## Key files

| File | Role |
|---|---|
| `types.ts` | Parsed workflow types and Mastra adapter collaborator contract types |
| `expression.ts` | Shared workflow expression grammar, reference field sets, and ref parsers |
| `schema.ts` | Source yaml to `ParsedForgeWorkflow` parser with lenient structural normalization |

## Dependencies

- Internal: none. Do not import from sibling folders.
- External: `yaml`.

## Notes

- `core/` performs semantic validation and intent resolution.
- `dsl/` builds Mastra workflows from resolved workflow contracts.
- Keep runtime IO and external package coupling out of this folder.
