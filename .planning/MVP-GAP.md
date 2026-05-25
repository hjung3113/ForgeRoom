# ForgeRoom Phase-1 MVP — Gap Analysis

Date: 2026-05-25. Analysed on working tree `integration/p4-effects` (#63 branch-publish + #64 label-lifecycle merged). Cross-referenced 5 open PR branches via `git diff main...<branch>` / `git show`.

Verification baseline (working tree, this branch):
- `pnpm test:unit` → **344 passed (38 files)**
- `pnpm test:integration` → **49 passed (10 files)** including the full `acceptance-matrix.*` suite (workflows, control-commands, safety-recovery), conductor scope-revert, recover-pending.
- e2e (`vitest.e2e.config.ts`) is a gated OpenClaw-provider harness, fake-by-default, live behind `FORGEROOM_OPENCLAW_E2E_LIVE=1`.

The architecture is essentially complete and tested. The single substantive functional gap is **prompt template loading (#68/#69)**. Everything else is integration/merge-ordering and human-gated credentials.

---

## Per-criterion verdict

### 1. Register 1 project + Discord `/run` runs the full pipeline — **DONE (code), PARTIAL (real prompts)**
- `/run` handler builds a `TaskRequest` and calls `orchestrator.startTask` → `OrchestratorGatewayPortImpl.startTask` → `engine.runFull`. Wired end-to-end.
  - `gateway/discord-gateway.ts:223` (handleRun), `app/gateway-port.ts:50` (startTask→runFull), `app/composition-root.ts:307,310` (engine + port wired).
- Covered by `acceptance-matrix.workflows.test.ts` against the REAL engine/conductor/check-runner/gateway.
- Caveat: prompts handed to the agent are stub headers, not the actual template content — see #6 / #10 below (the `renderBasePrompt` gap). So the *pipeline* runs full; the *prompt quality* is not real until #68 lands.

### 2. `full`/`quick`/`hotfix` invocation works — **DONE**
- All three workflows execute to `done` in `acceptance-matrix.workflows.test.ts:33,66,85` (quick plan→implement+checks→review_loop; hotfix linear; full plan→refine→foreach slices→final review_loop). Custom-from-`allowed_workflows` + admission rejection also covered (`:108,:126`).

### 3. Per-step Discord notifications — **DONE**
- `Reporter`/`ReporterSink` + outbox idempotency implemented (`core/reporting/reporter.ts`); `DiscordReporterSink` wired when a Discord status client is present (`composition-root.ts:384`). `notifyStepDone` emitted from `step-collaborators.ts:192`. Live Discord delivery is human-gated (token), but the sink + idempotent outbox are real and unit-tested.

### 4. `/ask <task>` — **DONE**
- `handleAsk` (`discord-gateway.ts:283`) → `askTask` → `Conductor.answer` (`gateway-port.ts:84`). `FileConductor.answer` reads `summary.md` and runs the meta-agent (`conductor/conductor.ts:201`). Covered by `acceptance-matrix.control-commands.test.ts:64`.

### 5. `/feedback <task>` folded into next step — **DONE**
- `handleFeedback` (`discord-gateway.ts:290`) → `recordFeedback` records a `user_feedback` event then calls `Conductor.integrateFeedback` (`gateway-port.ts:88`). `integrateFeedback` appends Pending bullets to `feedback.md`; `renderPrompt` calls `Conductor.refine` per step (`step-collaborators.ts:93`), and `update` promotes Pending→Applied on step success (`conductor.ts:121,142`). Covered by `control-commands.test.ts:76`.

### 6. ForgeMap build/select/stage into `.forgeroom/context/` — **DONE (staging), PARTIAL (template fetch is separate)**
- Real implementation, NOT a stub: `core/context/forgemap.ts` `ForgeMapStagerImpl.stage` does store-get-or-build, repo-state classify (clean/dirty/pending-rebuild with typed blocking errors), deterministic doc selection (project-profile baseline + referenced_path + matched_symbol + 1-hop depends_on), and writes snapshot copies under `.forgeroom/context/docs/`, `target-profile.md`, and `selected-forgemap.md` manifest. Wired with a real `BootstrapForgeMapStore` + git-CLI probe (`composition-root.ts:245`). Path-safety enforced (`safeJoinInsideRoot`, secret-path refusal).
- Note: this stages ForgeMap *context docs*; the per-step *prompt template* fetch is a different mechanism (the `renderPrompt` gap, #6 vs #10 are distinct concerns).

### 7. PR auto-creation end-to-end, mergeable in GitHub UI — **PARTIAL → blocked on #68 for real value**
- The effect chain IS present on this branch: `PullRequestExternalEffect` + `BranchPublisher` are wired into the engine (`pipeline-engine.ts:262,270`; PR `ensure`/reuse at `pull-request-external-effect.ts:85`; no-diff terminal success at `pipeline-engine.ts:594`). `composition-root.ts:272,276` build the real `PullRequestCreator` (Octokit) and `BranchPublisher` (git CLI). Branch-publish + PR-create + no-diff + failure→needs-info paths are integration-tested.
- The mechanics are DONE. But a PR created from header-only stub prompts contains no real agent work, so end-to-end *useful* PR creation depends on **#68** (real template prompts) and live GitHub token (human-gated). #63 (branch-publish) is already merged into this branch.

### 8. recoverPending resume after restart — **DONE**
- `MastraPipelineEngine.recoverPending` implemented as hybrid restart recovery (ADR-017): FILE-WINS pointer check → `run.resume()` for suspended runs, fresh reconstructed replay otherwise, last-step-failed left for user (`pipeline-engine.ts:445`). `composition-root.ts:339` calls it in `boot()`. Covered by `acceptance-matrix.safety-recovery.test.ts:162,184` and `recover-pending.test.ts`.

### 9. Dangerous-command rejection — **DONE**
- `ApprovalGate.checkCommand` placed both pre-Mastra (worktree admission) and in-step (the agent command in `step-collaborators.ts:113` throws `agent_error` when denied). Unit-tested (`approval-gate.test.ts`).

### 10. Step output-file retry (max 2) — **DONE (mechanism), PARTIAL (relationship to #69)**
- `DefaultAgentRunner.completeOutputAttempts` validates the output file (exists + ≥50 bytes) and retries up to `maxAttempts` (default 3 = first run + 2 retries) via session-resume or fresh re-run with a retry prompt (`agent-runner.ts:139`). Covered by `safety-recovery.test.ts:77`.
- Caveat re #69: the retry enforces *file written + byte floor*, NOT the semantic output contract (`## Slices`, `Review Result: pass/fail`). Those are parsed downstream (`output-selectors.ts`) but the contract instructions are **not injected into the prompt** — the harness (`harness-registry.ts`) only resolves a `source` path string and never loads a prompt/output contract. So the *retry acceptance* holds as written; but the *output contract* the spec describes (line 24 of phase-1-mvp.md) is only half-present. Closing #69 (load harness prompt/output contract into renderPrompt) is what makes the contract a real instruction rather than a post-hoc parse.

### 11. Conductor scope git-revert defense — **DONE**
- `FileConductor.guardedRun` snapshots git status before/after each meta-agent call, reverts any write outside the allowlist (`summary.md`/`feedback.md` + scratch prefixes), logs the violation, and keeps the agent text (`conductor.ts:225`). Real git adapter `GitCliConductorGit` wired (`composition-root.ts:202`). Covered by `safety-recovery.test.ts:128`.

### 12. `/cancel <task>` → canceled, queue proceeds — **DONE**
- `handleControl`→`cancelTask`→`engine.cancel` (`discord-gateway.ts:188`, `gateway-port.ts:72`). Cancel-from-paused + cannot-resume-after-cancel covered by `control-commands.test.ts:49`; resume guard at `pipeline-engine.ts:384`.

---

## THE one real functional gap: prompt template contents (#68 + #69)

On `main` and this working tree, `step-collaborators.ts` `renderBasePrompt` emits ONLY:
```
# Step: <stepId>
Template: <promptTemplate>      ← just the FILENAME, content never read
## Inputs
- <ref>: <path>
```
The named template files don't even exist on the tree (no `templates/` dir). So agents get a header that *names* a non-existent template.

- **#68 (`fix/p4-render-prompt-template`, "real-PR blocker")** replaces `renderBasePrompt` with `loadTemplate(templateRoot + relativePath)` + `{{placeholder}}` interpolation over `vars`/`input_refs`/`step_id`/`step_index`, fails fast on unknown placeholders, AND adds the `templates/` directory (execute/hotfix/implementation_plan/final_review/slice_impl/etc.) plus the `templateRoot` config + composition-root + main.ts wiring. This is the change that makes criteria 1/7 deliver *real* agent work. Verified via `git diff main...fix/p4-render-prompt-template` — it is a genuine implementation, not a doc tweak.
- **#69 (open issue, "prompt-file-protocol step 8")** loads the harness prompt/output contract so the `## Slices` / `Review Result: pass/fail` instructions are actually in the prompt. Today the contract is parser-enforced only. Required for the prompt-IO acceptance (criterion 10/line 24) to *truly* hold; deferrable for a first smoke run because the fake harness/tests inject contract-shaped output directly.

---

## Codex intent assessment (#65)

Workflows declare `codex_execute`/`codex_review`, but `configs/agents.yaml` has **both `claude` and `codex` agents set to `runtime: claude-cli`** (the #65 temp-route). There is **no codex gateway/provider** in the tree (`find apps -iname '*codex*'` → empty); OpenClawProvider is runtime-agnostic and just relays the `runtime` string.

Verdict: **real codex execution is NOT required for MVP acceptance.** None of the 12 criteria mention codex by name; they require "workflow steps run through the AgentRuntimeProvider." The temp-route satisfies every acceptance test (the harness even hard-codes `runtime: 'claude-cli'`). #65 (fix codex auth) is a quality/fidelity follow-on, not an MVP blocker. #66 (model-routing follow-ons) is likewise post-MVP.

---

## Merge / dependency order

Branch facts (verified):
- `refactor/p4-builder-port-inversion` (#67), `refactor/p4-runtime-target` (#70), `refactor/p4-model-policy` (#72) are a **linear stack**: #67 ⊂ #70 ⊂ #72. Merging #72 brings #67+#70 with it (one fast-forwardable chain off `main`).
- `integration/p4-effects` (#73, current) is **independent** of that stack: it carries #63 (branch-publish) + #64 (label-lifecycle) and is NOT a descendant of #67/#70/#72 (`git merge-base --is-ancestor` → NO).
- `fix/p4-render-prompt-template` (#68) branches off `main` (single commit), independent of both.

Known conflict (real): **#68 and #72 both edit** `core/engine/step-collaborators.ts`, `core/engine/pipeline-engine.ts`, `app/composition-root.ts`, `app/config.ts`, `Docs/concepts/prompt-file-protocol.md`, and the integration `acceptance-harness.ts` / `pipeline-engine.test.ts` / `recover-pending.test.ts`. #73 also touches `pipeline-engine.ts` + harness. So all three converge on the engine/harness files — sequential merges with conflict resolution are required; do not expect clean auto-merge.

Recommended landing sequence to `main` (each via PR, lint+typecheck+test gating):
1. **#72** (`model-policy`, brings #67+#70) — the refactor stack first; it is the largest surface and rebasing others onto it is cheaper than the reverse.
2. **#68** (render-prompt) rebased onto post-#72 `main` — resolve the step-collaborators/pipeline-engine/config/harness conflicts here. This is the highest-value functional change.
3. **#73** (`p4-effects`, #63+#64) rebased onto post-#68 `main` — resolve the remaining pipeline-engine/harness overlaps.
   (Order of 2 vs 3 is interchangeable, but whichever lands second eats the conflict; put the smaller-surface one last. #73 is larger, so prefer #68 second, #73 third.)
4. **#69** (harness contract) as a fresh PR after #68 — it depends on the #68 renderPrompt seam existing.

After step 3 the tree has: refactor stack + real templated prompts + branch-publish + PR-create + label-lifecycle = a buildable end-to-end MVP modulo live credentials.

---

## Buildable autonomously (pure code) vs human-gated

Buildable now, no human input:
- Merge/rebase + conflict resolution for #72 → #68 → #73 (pure code; tests are the oracle).
- #69 harness prompt/output-contract loading into renderPrompt (pure code; extends the #68 seam).
- Any remaining unit/integration test additions; doc/ADR sync.
- #71 (relocate OpenClawProvider out of `core/`) — pure refactor, no external dep.

Human-gated (cannot complete autonomously):
- **#65 real codex auth** — codex OAuth login / credential provisioning (interactive). Not MVP-blocking.
- **Live Discord** — bot token, application id, guild ids, allowed user ids (secrets in `.env`).
- **Live GitHub** — PAT/app token with PR + issue-label scopes (secret).
- **Live OpenClaw runtime** — endpoint + token for non-fake agent runs (`FORGEROOM_OPENCLAW_E2E_LIVE=1`).
- The final "register 1 project + drive `/run` from a real Discord and merge the PR in the GitHub UI" acceptance walkthrough (criteria 1 & 7 in the live sense) — needs all of the above.

---

## Existing end-to-end / live-integration harness

- **Integration suite** (`apps/orchestrator/tests/integration/`): the `acceptance-matrix.*` tests assemble the REAL engine/conductor/check-runner/forgemap/gateway/recoverPending against a real temp SQLite + real `.forgeroom/` tree, faking only external I/O (OpenClaw IPC, target-repo git, project commands, Reporter sinks, PR creator). This is the de-facto e2e seam and it is green (49 tests).
- **Gated e2e** (`vitest.e2e.config.ts`, `pnpm test:e2e`): OpenClaw-provider harness, fake by default, live behind `FORGEROOM_OPENCLAW_E2E_LIVE=1`. Plus `scripts/openclaw-live-smoke.mjs` (`pnpm smoke:openclaw`).
- **Live worktrees exist**: 8 `forge/livetest-*` git worktrees under `~/forgeroom-worktrees/forgeroom/` (e.g. `livetest-create-a-one-line-note-file-…`) — evidence a real live run has already been driven end-to-end on a prior branch. Confirms the live path is exercisable; not a checked-in automated harness.

---

## Recommended completion sequence

1. Land **#72** (refactor stack #67/#70/#72) to `main`.
2. Rebase + land **#68** (render-prompt + `templates/`) — resolve engine/harness/config conflicts. This unblocks real agent prompts → criteria 1 & 7 become functionally real.
3. Rebase + land **#73** (#63+#64 effects) — branch-publish + label-lifecycle.
4. Land **#69** (harness prompt/output-contract loading) on top of #68 — makes the output contract a real prompt instruction (criterion 10 fidelity / line 24).
5. (Optional, post-MVP) **#71** OpenClawProvider relocation; **#65** real codex auth; **#66** model-routing follow-ons; **#53** livetest note.
6. Provision human-gated secrets (Discord/GitHub/OpenClaw) and run the live acceptance walkthrough: register one project, drive `/run` for full/quick/hotfix + a custom workflow from a real Discord, confirm step notifications, `/ask`, `/feedback`, `/cancel`, restart-resume, dirty-command rejection, and merge the auto-created PR in the GitHub UI.

Steps 1–4 are fully autonomous. Step 6 is the only genuinely human/interactive gate.
