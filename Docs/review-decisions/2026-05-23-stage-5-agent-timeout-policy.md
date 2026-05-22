---
status: decided
date: 2026-05-23
scope: Stage 5 AgentRunner timeout default policy
---

# Stage 5 Agent Timeout Policy

## Decision

`DefaultAgentRunner` owns the Phase 1 default timeout for agent runs.

The default agent timeout is `DEFAULT_AGENT_TIMEOUT_MS = 300_000` (5 minutes).
`DefaultAgentRunnerOptions.defaultTimeoutMs` can override that value for the
runner instance.

When a caller request includes `timeoutMs`, AgentRunner preserves that explicit
per-request value. When the caller omits `timeoutMs`, AgentRunner applies the
runner default before calling the provider.

Provider calls always receive the effective timeout:

- initial `provider.run`
- internal output retry `provider.resume`
- internal retry fallback `provider.run` when no session exists
- selector-driven `provider.resume`
- selector-driven fallback `provider.run` when no session exists

OpenClawProvider remains a consumer of `timeoutMs`; it does not choose the
ForgeRoom default.

## Reason

Timeout is workflow/step execution policy, not provider capability policy. The
runner is the narrowest shared layer that can preserve explicit workflow values
while giving all Phase 1 provider calls a predictable timeout budget.

Keeping the default in AgentRunner avoids implementing Phase 2 config loading or
provider capability probing during Stage 5.

## Follow-Up Checks

- CheckRunner timeout defaults remain unresolved and belong to Stage 6.
- Phase 2 can add configuration loading without changing the provider contract.

