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

## Dependencies

- Internal: none. Do not import from sibling folders.
- External: none.

## Notes

- `core/` performs semantic validation and intent resolution.
- `dsl/` builds Mastra workflows from resolved workflow contracts.
- Keep runtime IO and external package coupling out of this folder.
