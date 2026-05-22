---
status: decided
date: 2026-05-23
scope: Stage 5 AgentRunner retry policy
---

# Stage 5 AgentRunner Retry Policy

## Decision

`DefaultAgentRunner` owns the Phase 1 output-producing attempt budget.

The default budget is `MAX_AGENT_ATTEMPTS = 3`, and the minimum generic output
size is `MIN_OUTPUT_BYTES = 50`.

The budget is spent on:

- missing output file
- output file smaller than `MIN_OUTPUT_BYTES`
- retryable provider failures: `timeout` and `agent_error`
- PipelineEngine-owned selector failures such as missing `## Slices` or
  `Review Result`, when PipelineEngine asks AgentRunner to continue the same
  output-producing flow

The budget is not spent on terminal provider readiness failures:

- `runtime_unavailable`
- `auth_failed`

When a failed attempt has `sessionId`, AgentRunner calls provider `resume` with
an explicit `AgentResumeRequest`. When `sessionId` is `null`, AgentRunner falls
back to a new provider `run` using the retry prompt as the next `promptPath`.

PipelineEngine can continue a workflow-specific selector failure by calling
`AgentRunner.resume` with an `AgentRunnerResumeRequest`. If the prior attempt
has `sessionId: null`, AgentRunner uses the addendum prompt as a new run prompt.
AgentRunner still does not parse `## Slices` or `Review Result`; it only spends
the shared budget and delegates the continuation prompt to the provider.

## Reason

Timeouts, generic agent errors, and invalid output can be corrected by asking
the runtime to produce the missing output. Provider readiness failures are
configuration or authentication problems; repeating the same request would hide
the root cause and waste the task budget.

PipelineEngine still owns workflow-specific selector parsing. AgentRunner only
validates generic file existence and byte length.

## Follow-Up Checks

- `pnpm test:unit apps/orchestrator/src/core/agent-runner.test.ts`
- `pnpm lint`
- `pnpm typecheck`
