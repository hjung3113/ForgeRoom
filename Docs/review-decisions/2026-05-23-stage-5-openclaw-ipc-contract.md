---
status: decided
date: 2026-05-23
scope: Stage 5 OpenClawProvider IPC contract
---

# Stage 5 OpenClaw IPC Contract

## Decision

ForgeRoom Stage 5 resolves OQ-004 at the ForgeRoom core boundary by defining an
injected OpenClaw IPC client contract in `openclaw-provider.ts` and locking that
shape with `openclaw-provider.test.ts`.

The real OpenClaw transport adapter remains an e2e/adapter verification item.

Provider `resume` receives an explicit `AgentResumeRequest` with cwd,
output/log paths, mode, and timeout. It must not depend on provider-local
in-memory state from a prior `run`.

## Reason

The Phase 1 core implementation needs a stable provider boundary before
AgentRunner retry behavior can be built. External OpenClaw availability is not
required to prove the ForgeRoom-side request/response contract.

## Follow-Up Checks

- `pnpm test:unit apps/orchestrator/src/core/openclaw-provider.test.ts`
- `pnpm lint`
- `pnpm typecheck`
