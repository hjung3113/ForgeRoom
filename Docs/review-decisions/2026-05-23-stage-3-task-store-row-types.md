---
status: decided
date: 2026-05-23
scope: Stage 3 TaskStore persistence
---

# Stage 3 TaskStore Row Types

## Decision

Stage 3 may add durable persistence row types such as `Check` to
`apps/orchestrator/src/core/types.ts` when the `TaskStore` public interface
needs to return those rows.

## Reason

`TaskStore` is a core boundary. Keeping persisted domain row types in `core`
lets `db` implement the interface without exporting database-specific row
shapes to later `PipelineEngine`, `CheckRunner`, or `Reporter` code.

## Boundary

This does not allow database implementation details, Drizzle row types, or
migration concerns into `core`. `core/types.ts` may contain stable domain
contracts only.
