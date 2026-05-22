---
status: living
last_reviewed: 2026-05-21
---

# utils/ Context Map

## Responsibility

Domain-independent helpers: logger, secret masking, path builders, environment variable validation, base error class.

## Key files (planned)

| File | Role |
|---|---|
| `logger.ts` | pino JSON logger + per-module child loggers |
| `secret-mask.ts` | Token / key pattern masking |
| `paths.ts` | Standard worktree-internal path builders (prompts, outputs, diffs) |
| `path-safety.ts` | Root-boundary and secret-path checks for adapters and core seams |
| `command-runner.ts` | Injectable command execution contract and Node child-process implementation |
| `env.ts` | zod schema for environment variables + validation |
| `errors.ts` | `OrchestratorError` base class |
| `time.ts` | Time utilities (sleep, withTimeout, etc.) |
| `*.test.ts` | Unit tests for utility helpers |

## Related docs

- [Coding rules — logging and errors](../../../../Docs/rules/coding-rules.md)
- [Security policy — masking patterns](../../../../Docs/policies/security.md)

## Dependencies

- External: `pino`, `zod`
- Node built-ins: `child_process`, `fs`, `path`, `stream`
- Internal: none (one-way)

## Entry guide

1. Define every environment variable in `env.ts` with a zod schema
2. Build `logger.ts` around a single pino instance plus `child({ module: '...' })`
3. Expose worktree path builders as functions:
   - `promptPath(worktree, index, stepId)`
   - `outputPath(worktree, index, stepId)`
   - `diffPath(worktree, index, stepId)`
4. Unit-test each helper
