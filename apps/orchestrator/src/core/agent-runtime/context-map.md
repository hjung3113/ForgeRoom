---
status: living
last_reviewed: 2026-05-25
---

# core/agent-runtime Context Map

## Responsibility

Agent execution contracts, resolved agent metadata, harness metadata, and the
OpenClaw runtime provider.

## Key Files

| File | Role |
|---|---|
| `agent-runner.ts` | AgentRunner retry/output-validation wrapper; defines `AgentRuntimeProvider`, `AgentRunRequest`, and the provider-neutral `ResolvedRuntimeTarget` (ADR-023) the runner derives from the resolved agent |
| `agent-registry.ts` | Agent config validation and lookup |
| `harness-registry.ts` | Harness config validation and lookup |
| `openclaw-provider.ts` | AgentRuntimeProvider implementation over OpenClaw IPC |
