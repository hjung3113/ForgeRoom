---
status: living
last_reviewed: 2026-05-23
---

# core/test-support Rules

Read [context-map.md](context-map.md) first.

## Responsibility

Shared fixtures, fakes, and builders for `core/*.test.ts` files.

## Rules

- Test support only; production modules must not import from this folder.
- Keep helpers domain-specific to core tests and small enough to understand at call sites.
- Do not perform external IO here; use in-memory fakes unless a test explicitly owns real IO.
- Preserve type safety against the production interfaces being faked.

## Upstream Rules

- [core rules](../AGENTS.md)
- [testing rules](../../../../../Docs/rules/testing-rules.md)
