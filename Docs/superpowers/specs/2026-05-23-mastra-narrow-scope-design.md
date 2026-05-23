---
status: draft
last_reviewed: 2026-05-23
authors: [hjung3113, claude-opus-4-7, codex-gpt-5.5]
---

# Mastra Narrow-Scope Adoption Design

> Replace ForgeRoom PipelineEngine's execution mechanics with Mastra workflow
> primitives. Keep all ForgeRoom-owned domain logic (Conductor, file prompt
> protocol, worktree manager, scope guard) intact. Add Mastra Studio for
> visualization and tracing.

## Motivation

Mid-Phase-1 MVP. PipelineEngine and Conductor are partially implemented.
Resume correctness, snapshot/replay semantics, and run visualization are the
hardest remaining areas — and they are exactly what mature workflow frameworks
provide for free.

Replacing the workflow execution layer with Mastra:
- Eliminates self-maintained pause/resume snapshot code
- Eliminates self-maintained step state machine + loop counters
- Provides Studio (workflow graph viz, trace inspector, step-by-step replay)
  that would otherwise cost weeks to build
- Keeps TS/Node stack — no language switch, no IPC

Out of scope (decided after codex review):
- Replacing Conductor with Mastra Memory (Mastra Memory is DB-backed; ForgeRoom
  `summary.md`/`feedback.md` are file artifacts and part of the product contract)
- Replacing file prompt protocol with framework state
- Switching to Python/LangGraph (no MVP value proportional to cost)
- Hybrid TS gateway + Python core (worst-of-both; IPC overhead, duplicated
  persistence/logging)
- CrewAI/AutoGen (agent-collaboration frameworks; would fight explicit DSL,
  worktree ownership, file artifact protocol)
- Inngest (durability-engine framework; too infrastructure-heavy for local
  single-process MVP; revisit if crash recovery becomes a real pain point)

## Architecture (revised)

```
[before]                          [after]
PipelineEngine (custom TS)    →   PipelineEngine = Mastra Workflow runner
  - DSL interpretation              - yaml DSL → Mastra workflow at load
  - step execution                  - .then / .foreach / .dountil / .suspend / .resume
  - review_loop loop                - .dountil() + max iterations
  - pause/resume (custom)           - Mastra suspend/resume (automatic snapshots)
  - no trace                        - Mastra Studio (graph viz + trace + inspector)

Conductor                         (unchanged; internal LLM calls may use Mastra Agent)
AgentRunner/OpenClawProvider      (unchanged; called from Mastra steps)
TaskStore / WorktreeManager       (unchanged; TaskStore step rows remain authoritative)
CheckRunner / Reporter            (unchanged)
DiscordGateway / GitHubGateway    (unchanged)
ApprovalGate / ForgeMap           (unchanged)
.forgeroom/* file protocol        (unchanged; Mastra Memory NOT used)
```

**Principle:** Mastra = workflow execution substrate. Domain logic (Conductor,
scope guard, file protocol, gateways) is ForgeRoom-owned.

## Change vs Keep Matrix

| Module / Surface | Action | Rationale |
|---|---|---|
| `core/pipeline-engine.ts` | **Rewrite** as Mastra workflow runner | Mastra primitives replace custom state machine |
| `dsl/workflow-parser.ts` | **Extend** with `to-mastra.ts` adapter | yaml DSL → `createWorkflow()` builder at load time |
| Pause/resume code inside PipelineEngine | **Remove** | Replaced by Mastra `suspend()` / `resume()` |
| `core/task-store.ts` step rows | **Keep** as authoritative state | Mastra snapshot is auxiliary; TaskStore is product source of truth |
| `core/conductor.*` | **Keep** as-is | Mastra Memory does not cover refine/update/scope-guard/file protocol |
| `core/agent-runner.ts` + `openclaw-provider.ts` | **Keep** | Called from inside Mastra steps |
| `core/check-runner.ts` | **Keep** | Called from inside Mastra steps |
| `core/reporter.ts` | **Keep** | Mastra step hooks emit Reporter events |
| `gateway/*` (Discord, GitHub) | **Keep** | Adapters, not workflow concerns |
| `core/approval-gate.ts` | **Keep** | Danger rejection inside steps |
| `core/forgemap.*` | **Keep** | Context staging is product concern |
| `core/worktree-manager.ts` | **Keep** | Side-effect ownership unchanged |
| `.forgeroom/{prompts,outputs,diffs,context}/` | **Keep** | First-class product state, debug contract |
| Mastra Studio | **Add** | `localhost:4111` for dev; optional for prod |

## DSL → Mastra Workflow Adapter

`dsl/to-mastra.ts` translates parsed ForgeRoom yaml workflow to Mastra
`createWorkflow()` graph at load time:

| ForgeRoom DSL primitive | Mastra equivalent |
|---|---|
| Sequential steps | `.then(step)` chain |
| `foreach: slices` | `.foreach()` (default sequential concurrency) |
| `review_loop` + `max_iterations` | `.dountil(condition)` with loop limit |
| `pause_after: true` | `step.suspend()` after step body |
| `kind: execute` step | step body calls `agentRunner.run()` + `checkRunner.run()` |
| `kind: refine` step | step body calls `conductor.refine()` |
| Variable interpolation | done in adapter, then passed as Mastra step input |
| `effects` metadata | preserved on adapter output; Reporter/Gateway still gate on it |

Adapter is the only place that knows both DSLs. ForgeRoom DSL semantics remain
the user-facing contract.

## Conductor Integration

Conductor stays a ForgeRoom-owned service called from inside Mastra steps:

```ts
const refineStep = createStep({
  id: 'refine-prompt',
  execute: async ({ inputData, runId }) => {
    const prompt = await conductor.refine(taskId, stepId, basePrompt);
    return { prompt };
  },
});
```

Internal Conductor LLM calls *may* migrate to Mastra `Agent` for trace coverage,
but the public Conductor interface (`refine`/`update`/`answer`/`feedback`/
`scopeGuard`) is unchanged. File artifacts (`summary.md`, `feedback.md`) remain
authoritative; Mastra Memory is not used.

## State of Truth

| State | Source of Truth | Replica / Audit |
|---|---|---|
| Task lifecycle (status, current step, retries) | TaskStore (SQLite) | Mastra snapshot |
| Step rows (start/end, outcome, artifacts) | TaskStore | Mastra trace |
| Workflow definition | yaml in `workflows.yaml` | Mastra workflow object (in-memory, rebuilt on load) |
| Prompts / outputs / diffs | `.forgeroom/<task>/` files | — |
| Conductor summary / feedback | `.forgeroom/<task>/context/` files | — |
| Run trace / step timings / token usage | Mastra trace store | Reporter events for product surfaces |
| ForgeMap selection log | ForgeRoom files | — |

Rule: on conflict, ForgeRoom state wins. Mastra snapshot is rebuildable from
TaskStore + yaml workflow.

## Studio Usage

- Local dev: run Mastra Studio on `localhost:4111` alongside orchestrator.
  Provides workflow graph viz, step-by-step run inspector, trace timeline,
  token usage.
- Prod: Studio is optional. If enabled, exposes the same trace store. Default
  off for security; Discord/GitHub are the user-facing surfaces.
- External agent calls (AgentRunner → OpenClawProvider CLI process) are wrapped
  as Mastra steps, so they appear in Studio trace with timing + I/O snippets.
  Full stdout/stderr stays in `.forgeroom/outputs/` files (Studio doesn't
  duplicate; Studio links by step id).

## Effort Estimate (~2 weeks, 1 dev)

| Day | Work |
|---|---|
| 1 | Install Mastra deps; bare Mastra workflow runner spike |
| 2–4 | `dsl/to-mastra.ts` adapter + unit tests covering all DSL primitives |
| 5–7 | Rewrite `PipelineEngine` as Mastra runner; existing integration tests pass |
| 8–9 | Migrate pause/resume/cancel to Mastra `suspend()`/`resume()` |
| 10 | Migrate `review_loop` to `.dountil()` + max_iterations |
| 11 | Studio dev guide; sample workflow visualization in docs |
| 12–13 | Write ADRs (015, 016, 017); update `architecture.md`, `pipeline-engine.md`, `workflow-dsl.md` |
| 14 | Buffer / cleanup / Stage 8 e2e prep |

## ADRs Required

- **ADR-015** — Adopt Mastra workflow primitives; redefine PipelineEngine
- **ADR-016** — yaml DSL → Mastra workflow adapter contract (mapping table)
- **ADR-017** — TaskStore step rows are authoritative; Mastra snapshot is auxiliary

## Open Questions

| Q | Note |
|---|---|
| OQ-M01: Does Mastra `.foreach()` snapshot mid-iteration on suspend? | Verify before relying on resume inside foreach |
| OQ-M02: All ForgeRoom DSL features map cleanly? (`pause_after`, custom `kind`, `effects` metadata) | Audit during adapter implementation |
| OQ-M03: Mastra version stability (pre-1.0?) — lock strategy | Pin minor version; vendor lock implications |
| OQ-M04: Studio trace coverage for external CLI agent process I/O | Spike to confirm |
| OQ-M05: Reporter event ordering vs Mastra step hooks | Ensure Reporter fires after TaskStore commit, not just step boundary |

## Decision Log

| Date | Decision | Source |
|---|---|---|
| 2026-05-23 | Reject LangGraph Python switch | codex review #1 |
| 2026-05-23 | Reject hybrid TS gateway + Python core | codex review #1 (worst option) |
| 2026-05-23 | Reject CrewAI / AutoGen (agent-collab frameworks fight explicit DSL + worktree ownership) | codex review #1 |
| 2026-05-23 | Reject Inngest for MVP; revisit if crash-recovery pain emerges | codex review #1 |
| 2026-05-23 | Reject Mastra Memory replacing Conductor file artifacts | codex review #2 (DB vs file = product contract violation) |
| 2026-05-23 | Mastra Studio adoption is the largest single ROI of the change | codex review #2 |
| 2026-05-23 | Mastra workflow execution primitives in; Conductor + file protocol out of scope | codex review #2 + user direction |

## Related Docs

- `Docs/overview.md`
- `Docs/architecture.md`
- `Docs/phases/phase-1-mvp.md`
- `Docs/modules/pipeline-engine.md`
- `Docs/modules/conductor.md`
- `Docs/concepts/workflow-dsl.md`
- `Docs/concepts/prompt-file-protocol.md`
- `Docs/decisions/` (ADRs)
