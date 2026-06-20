---
status: living
last_reviewed: 2026-05-25
---

# core/agent-runtime Context Map

## Responsibility

Agent execution contracts, resolved agent metadata, and harness metadata. This
folder is provider-neutral — the concrete agent-runtime provider lives in `app/`
(ADR-023 scope B, #71) so `core/` carries no provider-specific symbols.

## Key Files

| File | Role |
|---|---|
| `agent-runner.ts` | AgentRunner retry/output-validation wrapper; defines `AgentRuntimeProvider`, `AgentRunRequest`, and the provider-neutral `ResolvedRuntimeTarget` (ADR-023) the runner derives from the resolved agent |
| `task-agent-lifecycle.ts` | Provider-neutral `TaskAgentLifecycle` seam + `ephemeralAgentIdForTask` (`fr-<taskid>`): per-task worktree-bound ephemeral agent (ADR-030). Impl in `app/openclaw-task-agent-lifecycle.ts` |
| `agent-registry.ts` | Agent config validation and lookup |
| `harness-registry.ts` | Harness config validation and lookup |
