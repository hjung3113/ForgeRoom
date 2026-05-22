---
status: planned
last_reviewed: 2026-05-22
---

# Goal Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or the orchestration protocol in `Docs/prompts/goal-feature-orchestration-prompt.md`. Steps use checkbox syntax for tracking.

Goal: Build the ForgeRoom Phase 1 MVP orchestrator so a task request can flow through project/workflow validation, worktree bootstrap, file-based agent execution, checks, reporting events, pause/resume/cancel, and PR-ready completion without merging this branch.

Architecture: The initial implementation keeps business logic in `apps/orchestrator/src/core`, pure DSL parsing in `apps/orchestrator/src/dsl`, SQLite persistence in `apps/orchestrator/src/db`, and external adapters in `apps/orchestrator/src/gateway`. The first production runtime uses dependency injection and fakeable interfaces so the Phase 1 acceptance scenarios can be covered by unit and integration tests before real Discord, GitHub, and OpenClaw credentials are used. The implementation follows ADR-001, ADR-002, ADR-004, ADR-006, ADR-011, ADR-012, ADR-013, and ADR-014.

Tech Stack: Node.js 20+, TypeScript, Vitest, ESLint, Prettier, SQLite with `better-sqlite3` and Drizzle, `yaml`, `zod`, `discord.js`, and Octokit.

## Source Documents

- `Docs/overview.md`
- `Docs/architecture.md`
- `Docs/phases/phase-1-mvp.md`
- `Docs/concepts/data-model.md`
- `Docs/concepts/workflow-dsl.md`
- `Docs/concepts/prompt-file-protocol.md`
- `Docs/concepts/conductor-model.md`
- `Docs/modules/pipeline-engine.md`
- `Docs/modules/task-store.md`
- `Docs/modules/agent-runner.md`
- `Docs/modules/check-runner.md`
- `Docs/modules/worktree-manager.md`
- `Docs/modules/workflow-registry.md`
- `Docs/modules/reporter.md`
- `Docs/modules/project-registry.md`
- `Docs/modules/approval-gate.md`
- `Docs/modules/discord-gateway.md`
- `Docs/modules/github-gateway.md`
- `Docs/modules/forgemap.md`
- `Docs/open-questions.md`
- `Docs/glossary.md`
- `Docs/decisions/README.md`

## Non-Goals

- No merge to `main` from this branch.
- No Discord approval gate beyond MVP danger rejection.
- No raw stdout streaming.
- No `review_only` workflow.
- No Local CLI, GitHub Enterprise, git issue, OpenCodeProvider, HermesProvider, or direct CLI provider implementation.
- No ForgeMap external ingestion from issue history, PR history, official docs, internal wiki, or ticket systems.
- No parallel sub-task execution inside one ForgeRoom task.
- No desktop GUI, Tailscale, distributed queue, or multi-machine runtime.

## Plan Review Cycle 1

Review goal: Find conflicts between Phase 1 docs and the implementation plan.

Initial findings:
- The current repo has only source folder skeletons, so toolchain setup is the first TDD slice.
- Current canonical docs say Phase 1 provider is `OpenClawProvider`; `OpenCodeProvider` remains out of scope.
- Full Discord/GitHub/OpenClaw e2e can only be represented by adapter contract tests and a documented manual `test:e2e` gate until real credentials exist.
- Review Result: fail. The first adversarial architecture review found that `OpenClawProvider`, Intent/Agent/Harness registries, ForgeMap structured map artifacts, data-model invariants, OQ-004, and OQ-007 were underspecified.

Refinement applied:
- The stages below implement provider-neutral interfaces first and real external adapters last.
- Gateway implementations are limited to MVP Discord slash commands and GitHub.com issue label polling/PR creation.
- Completion requires unit and integration tests plus an explicit e2e command surface, while real external e2e can be reported as manual if credentials are unavailable.
- Stage 2 now includes IntentRegistry, AgentRegistry, HarnessRegistry, and config templates.
- Stage 5 now contains an explicit `OpenClawProvider` slice with fake IPC contract tests and OQ-004 evidence.
- Stage 3 now requires transaction and data-model invariant tests beyond table existence.
- Stage 6 now requires ForgeMap structured artifacts, stale checks, selection logs, and dirty-baseline evidence.
- Stage 8 now requires a credentialed manual or automated E2E evidence checklist mapped 1:1 to Phase 1 acceptance.

## Plan Review Cycle 2

Review goal: Find untestable acceptance, oversize slices, module boundary violations, and YAGNI risks.

Initial findings:
- Implementing all modules in one slice would hide TDD evidence and make reviews too broad.
- `PipelineEngine` risks becoming too large if DSL evaluation, file IO, checks, and persistence are not separated.
- `TaskStore` must be tested against SQLite constraints rather than mocked for concurrency invariants.
- Review Result: fail. The TDD/module-boundary review found selector ownership in the wrong layer, missing ForgeMap file IO adapter seams, overlarge Worktree/Agent/Check and Pipeline stages, weak CheckRunner/AgentRunner regressions, and weak E2E evidence.

Refinement applied:
- Stages are split by observable behavior and each task names its red/green command.
- `dsl/` owns parsing and expression evaluation; `core/` consumes parsed workflows.
- SQLite schema and lock behavior get integration tests before engine resume behavior is implemented.
- Output selector parsing for `## Slices` and `Review Result` now belongs to `PipelineEngine` or a `core` helper used by `PipelineEngine`, not `dsl/`.
- File IO for ForgeMap, worktree bootstrap, prompt artifacts, and logs is performed through injected adapters in `utils` or gateway/db seams; `core` owns interfaces and business rules.
- Stage 4 and the original lifecycle stage are split into narrower reviewable stages.
- CheckRunner and AgentRunner tests now name command-not-found, timeout, failure-after-fix, selector-budget, sessionless fallback, and no-new-step-row invariants.

## Major Stages

- Stage 1: Toolchain and shared contracts
- Stage 2: DSL, intent, agent, harness, and registry validation
- Stage 3: SQLite TaskStore and domain events
- Stage 4: Worktree, filesystem seams, and ApprovalGate safety
- Stage 5: AgentRunner, OpenClawProvider, and output contract
- Stage 6: CheckRunner and check-fix contract
- Stage 7: PipelineEngine execution, selectors, loops, lifecycle, and recovery
- Stage 8: ForgeMap and Conductor context staging
- Stage 9: Reporter, DiscordGateway, GitHubGateway, and PR-ready handoff
- Stage 10: End-to-end verification, final reviews, and user review request

## TDD Policy

- Red command: run the narrowest Vitest target for the new behavior before production code exists.
- Green command: rerun the same narrow target after minimal implementation.
- Refactor command: rerun the narrow target plus the owning package test command.
- Regression command before stage review: `pnpm lint && pnpm typecheck && pnpm test:unit`; when integration behavior exists, also run `pnpm test:integration`.
- Every stage records red, green, and refactor evidence in the stage review note or final handoff.

## Review Policy

- Each major stage receives one adversarial expert review after green/refactor evidence is available.
- A failed stage review creates a refinement task in the same stage before moving on.
- Final review runs two cycles with architecture, TDD/test quality, module boundary, reliability, and user-review readiness perspectives.

## Stage 1: Toolchain and Shared Contracts

Stage Goal: The repository has a working Node.js + TypeScript + Vitest baseline and exported core contracts matching the docs.

Allowed files:
- `package.json`
- `pnpm-workspace.yaml`
- `tsconfig.json`
- `eslint.config.js`
- `prettier.config.js`
- `vitest.config.ts`
- `apps/orchestrator/package.json`
- `apps/orchestrator/tsconfig.json`
- `apps/orchestrator/src/core/types.ts`
- `apps/orchestrator/src/core/errors.ts`
- `apps/orchestrator/src/utils/*`
- folder `AGENTS.md` and `context-map.md` updates already required by folder rules

Tests:
- `apps/orchestrator/src/core/types.test.ts`
- `apps/orchestrator/src/core/errors.test.ts`
- `apps/orchestrator/src/utils/path-safety.test.ts`

Tasks:
- [ ] Write failing tests for typed errors, safe worktree path checks, and exported task/step/check/reporter types.
- [ ] Run `pnpm test:unit -- --run apps/orchestrator/src/core/errors.test.ts apps/orchestrator/src/utils/path-safety.test.ts`; expected red: missing modules.
- [ ] Add the minimal TypeScript toolchain and implementation files.
- [ ] Run the same command; expected green.
- [ ] Run `pnpm lint && pnpm typecheck && pnpm test:unit`; expected green.

Acceptance checklist:
- [ ] No production code exists without a preceding failing test.
- [ ] TypeScript strict mode is enabled.
- [ ] `core` does not import from `db`, `dsl`, or `gateway`.
- [ ] Generated source, configs, and docs contain no incomplete planning language.
- [ ] Context maps for touched folders list the new files accurately.
- [ ] Stage adversarial review completed and refinements applied.

## Stage 2: DSL, Intent, Agent, Harness, and Registry Validation

Stage Goal: ForgeRoom can parse registry config, resolve workflow executable steps through Intent/Agent/Harness registries, and reject invalid DSL shapes without running agents.

Allowed files:
- `apps/orchestrator/src/dsl/types.ts`
- `apps/orchestrator/src/dsl/workflow-parser.ts`
- `apps/orchestrator/src/dsl/variable-interpolator.ts`
- `apps/orchestrator/src/dsl/foreach.ts`
- `apps/orchestrator/src/dsl/until.ts`
- `apps/orchestrator/src/dsl/dsl-errors.ts`
- `apps/orchestrator/src/core/workflow-registry.ts`
- `apps/orchestrator/src/core/project-registry.ts`
- `apps/orchestrator/src/core/intent-registry.ts`
- `apps/orchestrator/src/core/agent-registry.ts`
- `apps/orchestrator/src/core/harness-registry.ts`
- `configs/workflows.yaml`
- `configs/intents.yaml`
- `configs/agents.yaml`
- `configs/harnesses.yaml`

Tests:
- `apps/orchestrator/src/dsl/*.test.ts`
- `apps/orchestrator/src/core/workflow-registry.test.ts`
- `apps/orchestrator/src/core/project-registry.test.ts`
- `apps/orchestrator/src/core/intent-registry.test.ts`
- `apps/orchestrator/src/core/agent-registry.test.ts`
- `apps/orchestrator/src/core/harness-registry.test.ts`

Tasks:
- [ ] Red: tests reject intent config without `kind`, `agent`, or `harness`; agent config without `provider: openclaw`, `runtime`, `model`, or harness reference; harness config without an existing source.
- [ ] Green: implement IntentRegistry, AgentRegistry, HarnessRegistry, and default config templates.
- [ ] Red: tests reject workflow steps with direct `agent`, `kind`, `harness`, inline `prompt`, missing `effects`, invalid `review_loop.until`, unsafe `prompt_template`, unknown intent, and non-`${task.final_slices}` MVP foreach.
- [ ] Green: implement parser and validation with clear error messages.
- [ ] Refactor: keep parser, interpolation, foreach, and until logic in separate files.

Acceptance checklist:
- [ ] DSL behavior matches `Docs/concepts/workflow-dsl.md`.
- [ ] `ResolvedStep` is derived from workflow step plus intent plus agent plus harness.
- [ ] Output selectors are not implemented in `dsl/`; they are deferred to Stage 7 `PipelineEngine`.
- [ ] WorkflowRegistry disables only unreferenced invalid workflows and fails startup for referenced invalid workflows.
- [ ] ProjectRegistry validates `default_workflow`, `allowed_workflows`, absolute path, commands, and maintainers.
- [ ] Stage adversarial review completed and refinements applied.

## Stage 3: SQLite TaskStore and Domain Events

Stage Goal: TaskStore persists tasks, steps, checks, events, deliveries, locks, and conductor state with the data-model invariants.

Allowed files:
- `apps/orchestrator/src/db/schema.ts`
- `apps/orchestrator/src/db/client.ts`
- `apps/orchestrator/src/db/migrate.ts`
- `apps/orchestrator/src/db/migrations/*`
- `apps/orchestrator/src/db/sqlite-task-store.ts`
- `apps/orchestrator/src/core/task-store.ts`

Tests:
- `apps/orchestrator/src/db/sqlite-task-store.test.ts`
- `tests/integration/task-store-locks.test.ts`

Tasks:
- [ ] Red: tests prove one active task per project is enforced in SQLite.
- [ ] Green: create schema, migration, and task CRUD.
- [ ] Red: tests prove check rows are append-only by `check_fix_attempt`.
- [ ] Green: implement check and step updates.
- [ ] Red: tests prove event delivery retry fields persist and due deliveries are listed.
- [ ] Green: implement event outbox methods.
- [ ] Red: tests prove `createTask` plus project lock acquisition is atomic.
- [ ] Green: wrap task start in a transaction.
- [ ] Red: tests prove `updateStep` plus `step_done` event insertion is atomic.
- [ ] Green: wrap step completion in a transaction.
- [ ] Red: tests prove cancel updates task status, records `task_canceled`, and releases the project lock in one transaction.
- [ ] Green: implement transactional cancel.
- [ ] Red: tests prove conductor_state upsert, user_feedback `applied_at` markers, canonical failure reasons, `external_ref.status_comment_id`, and `external_ref.status_message_id` persist and reload.
- [ ] Green: implement the missing persistence methods and JSON serialization.
- [ ] Refactor: keep transaction boundaries explicit around task start, step completion, cancel, and lock release.

Acceptance checklist:
- [ ] Schema matches `Docs/concepts/data-model.md`.
- [ ] TaskStore interface matches `Docs/modules/task-store.md`.
- [ ] Integration tests use temporary SQLite files or `:memory:` only.
- [ ] Transaction tests prove the invariants `PipelineEngine` depends on.
- [ ] Stage adversarial review completed and refinements applied.

## Stage 4: Worktree, Filesystem Seams, and ApprovalGate Safety

Stage Goal: ForgeRoom can safely bootstrap task worktrees and `.forgeroom/` artifact directories through injected filesystem/git adapters, while ApprovalGate rejects dangerous commands and paths.

Allowed files:
- `apps/orchestrator/src/core/worktree-manager.ts`
- `apps/orchestrator/src/core/approval-gate.ts`
- `apps/orchestrator/src/core/types.ts`
- `apps/orchestrator/src/utils/git-client.ts`
- `apps/orchestrator/src/utils/file-system.ts`
- `apps/orchestrator/src/utils/path-safety.ts`

Tests:
- `apps/orchestrator/src/core/worktree-manager.test.ts`
- `apps/orchestrator/src/core/approval-gate.test.ts`
- `apps/orchestrator/src/utils/path-safety.test.ts`

Tasks:
- [ ] Red: worktree tests require idempotent `.forgeroom/` bootstrap with `context`, `context/docs`, `prompts`, `outputs`, `diffs`, and `logs`.
- [ ] Green: implement WorktreeManager with injected git and file-system adapters.
- [ ] Red: tests reject worktree creation on `main`, inside the target project path, outside allowed roots, or with secret paths.
- [ ] Green: implement ApprovalGate file and workflow safety checks.
- [ ] Red: tests reject dangerous commands including `git push --force`, `git reset --hard origin/...`, `rm -rf /`, secret path access, migration/reset commands, and `curl | sh`.
- [ ] Green: implement command safety checks.
- [ ] Refactor: keep filesystem and git operations outside direct `core` imports.

Acceptance checklist:
- [ ] `core` consumes injected interfaces for git and filesystem behavior.
- [ ] `.forgeroom/` bootstrap matches `Docs/concepts/prompt-file-protocol.md`.
- [ ] Dangerous commands and secret paths are rejected before execution.
- [ ] Stage adversarial review completed and refinements applied.

## Stage 5: AgentRunner, OpenClawProvider, and Output Contract

Stage Goal: ForgeRoom has the MVP `OpenClawProvider`, provider-neutral AgentRunner attempts, output-file validation, timeout handling, and OQ-004 IPC evidence.

Allowed files:
- `apps/orchestrator/src/core/agent-runner.ts`
- `apps/orchestrator/src/core/openclaw-provider.ts`
- `apps/orchestrator/src/core/types.ts`
- `apps/orchestrator/src/utils/openclaw-ipc-client.ts`
- `apps/orchestrator/src/utils/file-system.ts`
- `Docs/open-questions.md`

Tests:
- `apps/orchestrator/src/core/agent-runner.test.ts`
- `apps/orchestrator/src/core/openclaw-provider.test.ts`

Tasks:
- [x] Red: OpenClawProvider tests require `health`, `run`, and `resume` to translate ForgeRoom requests into OpenClaw IPC client calls with runtime, model, cwd, prompt path instruction, output path instruction, stdout path, and stderr path.
- [x] Green: implement OpenClawProvider against an injected fake OpenClaw IPC client.
- [x] Red: tests document the selected OQ-004 IPC shape and fail if endpoint/token/runtime inputs are missing.
- [x] Green: implement config validation and update OQ-004 status only if the IPC shape is confirmed by implementation evidence.
- [x] Red: AgentRunner tests require missing output, output smaller than `MIN_BYTES`, provider non-zero, timeout, and output selector failure to consume the same output-producing attempt budget.
- [x] Green: implement AgentRunner attempt handling.
- [x] Red: AgentRunner tests require provider `resume` when `sessionId` exists and a new headless run fallback when `sessionId === null`.
- [x] Green: implement resume and fallback.
- [x] Red: tests require timeout defaults from OQ-007 to be configurable at the workflow/step policy seam.
- [x] Green: implement timeout default and config plumbing without adding Phase 2 behavior.
- [x] Refactor: keep provider-specific raw diagnostics in logs, not public ForgeRoom failure contracts.

Acceptance checklist:
- [x] MVP has a concrete `OpenClawProvider` implementation, not only a fake provider.
- [x] `OpenCodeProvider`, `HermesProvider`, and direct CLI providers remain out of scope.
- [x] AgentRunner owns output validation and retry semantics.
- [x] OQ-004 and OQ-007 are either resolved with evidence or left pending with explicit implementation blockers.
- [x] Stage adversarial review completed and refinements applied.

## Stage 6: CheckRunner and Check-Fix Contract

Stage Goal: ForgeRoom runs project verification commands directly after `kind: execute` steps and records/fixes check failures with one separate check-fix budget.

Allowed files:
- `apps/orchestrator/src/core/check-runner.ts`
- `apps/orchestrator/src/core/approval-gate.ts`
- `apps/orchestrator/src/core/agent-runner.ts`
- `apps/orchestrator/src/utils/command-runner.ts`
- `apps/orchestrator/src/utils/file-system.ts`

Tests:
- `apps/orchestrator/src/core/check-runner.test.ts`
- `apps/orchestrator/src/core/approval-gate.test.ts`

Tasks:
- [ ] Red: CheckRunner tests require `kind: execute` check command failures to record attempt 0, call the fix agent once, and record attempt 1.
- [ ] Green: implement CheckRunner with injected command runner and ApprovalGate.
- [ ] Red: tests require command-not-found to record exit code 127 and artifact paths.
- [ ] Green: implement command-runner result normalization.
- [ ] Red: tests require timeout to terminate, record timeout failure, and write stdout/stderr paths.
- [ ] Green: implement timeout handling.
- [ ] Red: tests require check-fix failure after one retry to set `failure_reason=check_failed_after_fix`.
- [ ] Green: implement failure-after-fix handling.
- [ ] Red: tests prove check fixes update the original execute step row and do not create a new workflow step row.
- [ ] Green: implement check-fix persistence contract.
- [ ] Refactor: keep child process execution in `utils`, not `core`.

Acceptance checklist:
- [ ] CheckRunner runs ForgeRoom-owned verification commands directly, not through OpenClaw.
- [ ] Check fix budget is separate from AgentRunner output-producing attempts.
- [ ] Failure logs include the last 200 stdout/stderr lines in the check-fix prompt artifact.
- [ ] Stage adversarial review completed and refinements applied.

## Stage 7: PipelineEngine Execution, Selectors, Loops, Lifecycle, and Recovery

Stage Goal: PipelineEngine executes run, group, and review_loop steps; handles final slices, pause/resume/cancel; and recovers pending tasks after restart.

Allowed files:
- `apps/orchestrator/src/core/pipeline-engine.ts`
- `apps/orchestrator/src/core/conductor.ts`
- `apps/orchestrator/src/core/types.ts`
- Stage 2-4 modules only as needed for integration seams

Tests:
- `apps/orchestrator/src/core/pipeline-engine.test.ts`
- `tests/integration/pipeline-engine.test.ts`

Tasks:
- [ ] Red: tests prove `runFull` creates task, lock, worktree, initial context, and first prompt.
- [ ] Green: implement `runFull` with dependency injection.
- [ ] Red: tests parse `## Slices` from plan/refine outputs inside `PipelineEngine` or a `core` helper only.
- [ ] Green: implement `task.final_slices` selector parsing and validation.
- [ ] Red: tests parse exact `Review Result: pass/fail` headers inside `PipelineEngine` or a `core` helper only.
- [ ] Green: implement review result selector parsing and output contract retry.
- [ ] Red: tests prove `implementation_plan` slices initialize `task.final_slices`, `refine_plan` always refreshes them, and zero slices fail with `output_contract_failed`.
- [ ] Green: implement selector evaluation and final slice state.
- [ ] Red: tests prove review_loop max iterations fail with `review_loop_max_iterations`.
- [ ] Green: implement review_loop control rows and child step execution.
- [ ] Red: tests prove pause, resume, cancel, and recoverPending transitions.
- [ ] Green: implement lifecycle methods.
- [ ] Red: integration tests prove cancel releases the project lock and a queued task for the same project can proceed.
- [ ] Green: connect PipelineEngine cancel to TaskStore transactional cancel.
- [ ] Red: integration tests prove `recoverPending` resumes from a done step, restarts a running step, leaves failed tasks for user decision, and never resumes canceled tasks.
- [ ] Green: implement recovery decisions.
- [ ] Refactor: extract step execution helpers if `pipeline-engine.ts` approaches the file-size guideline.

Acceptance checklist:
- [ ] `PipelineEngine` responsibilities match `Docs/modules/pipeline-engine.md`.
- [ ] `kind: execute` is the only CheckRunner trigger.
- [ ] Canceled tasks do not resume.
- [ ] `PipelineEngine` owns workflow output selector semantics; `dsl/` does not.
- [ ] Stage adversarial review completed and refinements applied.

## Stage 8: ForgeMap and Conductor Context

Stage Goal: Task start stages selected ForgeMap context into `.forgeroom/context/`, and Conductor refine/update/answer/integrateFeedback operate only on allowed task-local context files.

Allowed files:
- `apps/orchestrator/src/core/forgemap.ts`
- `apps/orchestrator/src/core/conductor.ts`
- `apps/orchestrator/src/core/pipeline-engine.ts`
- `apps/orchestrator/src/utils/path-safety.ts`
- `apps/orchestrator/src/utils/file-system.ts`
- `apps/orchestrator/src/utils/git-client.ts`

Tests:
- `apps/orchestrator/src/core/forgemap.test.ts`
- `apps/orchestrator/src/core/conductor.test.ts`
- `tests/integration/context-staging.test.ts`

Tasks:
- [ ] Red: tests require ForgeMap storage to include `forgemap.yaml`, purpose-specific markdown docs, `symbols/*.json`, source revision, and generated metadata under `~/forgeroom/maps/<project-id>/`.
- [ ] Green: implement file-based ForgeMap store through injected filesystem adapters.
- [ ] Red: tests require stale check behavior for source revision mismatch, pending rebuild state, dirty baseline recording, and modification workflow block without maintainer approval.
- [ ] Green: implement stale and dirty-baseline decisions.
- [ ] Red: tests require selected source docs, selected-forgemap manifest, target profile snapshot, readable staged paths, short summaries, and selection log reasons under `.forgeroom/context/`.
- [ ] Green: implement ContextSelector staging.
- [ ] Red: tests require Conductor scope violations to revert changes outside `summary.md` and `feedback.md`.
- [ ] Green: implement scope guard with WorktreeManager snapshots.
- [ ] Red: tests require `/ask` answers to use summary and recent output paths.
- [ ] Green: implement Conductor answer boundary.
- [ ] Refactor: keep ForgeMap file-based and avoid external ingestion.

Acceptance checklist:
- [ ] ForgeMap remains file-based MVP context, not broad RAG.
- [ ] ForgeMap includes structured selection substrate, not only markdown staging.
- [ ] Conductor never changes workflow order, intent, agent, harness, or prompt template.
- [ ] `core` performs ForgeMap file IO through injected adapters.
- [ ] Stage adversarial review completed and refinements applied.

## Stage 9: Reporter, DiscordGateway, GitHubGateway, and PR-Ready Handoff

Stage Goal: External surfaces can create task requests, report status, collect feedback/questions, cancel tasks, and create a GitHub.com PR according to workflow effects.

Allowed files:
- `apps/orchestrator/src/core/reporter.ts`
- `apps/orchestrator/src/gateway/discord-gateway.ts`
- `apps/orchestrator/src/gateway/github-gateway.ts`
- `apps/orchestrator/src/gateway/types.ts`
- `apps/orchestrator/src/index.ts`
- config templates under `configs/`

Tests:
- `apps/orchestrator/src/core/reporter.test.ts`
- `apps/orchestrator/src/gateway/discord-gateway.test.ts`
- `apps/orchestrator/src/gateway/github-gateway.test.ts`
- `tests/integration/reporter-outbox.test.ts`

Tasks:
- [ ] Red: Reporter tests require events before delivery rows and idempotent delivery marking.
- [ ] Green: implement Reporter and sinks as interfaces with fake adapters in tests.
- [ ] Red: Reporter tests require `effects.external.report` values `none`, `status`, and `final`, plus `effects.external.pr` values `none`, `draft`, and `ready`.
- [ ] Green: implement workflow-effect-aware delivery and PR policies.
- [ ] Red: DiscordGateway tests require `/run`, `/pause`, `/resume`, `/cancel`, `/status`, `/ask`, and `/feedback` command routing.
- [ ] Green: implement Discord command handler without real network in unit tests.
- [ ] Red: GitHubGateway tests require issue-label task creation, status comment marker recovery, and PR body generation.
- [ ] Green: implement GitHub gateway adapter boundaries.
- [ ] Refactor: keep gateway code out of `core`.

Acceptance checklist:
- [ ] Reporter follows workflow `effects.external.report` and `effects.external.pr`.
- [ ] Discord and GitHub tests use mocks or fake interfaces only.
- [ ] PR creation is ready for GitHub UI merge, but this branch is not merged.
- [ ] Stage adversarial review completed and refinements applied.

## Stage 10: End-to-End Verification and User Review Request

Stage Goal: The branch is review-ready with green automated gates, recorded TDD/review evidence, and no merge performed.

Allowed files:
- `tests/integration/full-mvp-flow.test.ts`
- `tests/e2e/README.md`
- `tests/e2e/phase-1-mvp-checklist.md`
- `Docs/reviews/2026-05-22-goal-feature-final-review.md`
- final updates to changed folder `context-map.md` files

Tests:
- `tests/integration/full-mvp-flow.test.ts`
- `tests/e2e/phase-1-mvp-checklist.md` documents credentialed manual e2e procedure with pass/fail fields

Tasks:
- [ ] Red: integration test fails until a fake Discord or GitHub task can run `full`, `quick`, and `hotfix` workflows to PR-ready state.
- [ ] Green: implement missing glue until the integration test passes with fake external providers and fake AgentRuntimeProvider.
- [ ] Write `tests/e2e/phase-1-mvp-checklist.md` with all 12 Phase 1 acceptance items mapped to actual OpenClaw, git, Discord test channel, and GitHub.com test repo evidence fields.
- [ ] Add `pnpm test:e2e` or document the exact manual command sequence if credentials are unavailable in the current environment.
- [ ] Run `pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:integration`.
- [ ] Run `npm run lint`, `npm run typecheck`, and `npm test` only if the final package exposes npm-compatible aliases; otherwise record the pnpm equivalents.
- [ ] Conduct final review cycle 1 and apply required refinements.
- [ ] Conduct final review cycle 2 and apply required refinements or report blockers.
- [ ] Prepare final user review request with branch name, changed files, verification results, review summaries, remaining concerns, and explicit no-merge status.

Acceptance checklist:
- [ ] Phase 1 acceptance items are each mapped to automated or documented manual evidence.
- [ ] Real OpenClaw, git, Discord, and GitHub.com e2e evidence is recorded, or unavailable credentials are explicitly reported as the remaining manual verification gap.
- [ ] No secrets or `.env` files are committed.
- [ ] `git status --short --branch` proves work remains on the feature branch.
- [ ] Final handoff asks for user review and does not request or perform merge.
