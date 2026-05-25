/**
 * PipelineEngine — Mastra runner (#8).
 *
 * Public lifecycle (runFull/runNextStep/pause/resume/cancel/recoverPending) is
 * stable; internally each task runs as a Mastra workflow built by the #6 adapter
 * ({@link toMastraWorkflow}). The engine owns the collaborator seam the adapter's
 * step bodies call (renderPrompt -> runAgent -> selector validation ->
 * CheckRunner -> diff save -> Conductor.update -> Reporter), wiring the real
 * AgentRunner / CheckRunner / Conductor / ApprovalGate / WorktreeManager and
 * fakes for not-yet-built modules (Reporter / ForgeMap) behind small interfaces.
 *
 * Authority: SQLite TaskStore is authoritative; the Mastra run snapshot is
 * auxiliary (ADR-017). `mastra_run_id` is recorded on the task row right after
 * `wf.createRun()` and BEFORE `run.start()`, so a crashed process can be
 * recovered (issue #9 completes the hybrid recovery).
 */
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { Mastra } from '@mastra/core';
import { InMemoryStore } from '@mastra/core/storage';
import type { WorkflowRunState } from '@mastra/core/workflows';

import type { AgentRunner } from '../agent-runtime/agent-runner.js';
import type { ApprovalGate } from '../checks/approval-gate.js';
import type { Conductor, Reporter, Task } from '../types.js';
import type { TaskStore, CreateTaskInput } from '../task-store.js';
import type { ProjectRegistry, ProjectMeta } from '../registries/project-registry.js';
import type { IntentRegistry } from '../registries/intent-registry.js';
import type { WorkflowRegistry } from '../registries/workflow-registry.js';
import type { WorktreeManager } from '../worktree/worktree-manager.js';
import type { CheckRunnerRequest } from '../checks/check-runner.js';
import type { CheckRunResult, Step } from '../types.js';
import { parseSlicesOutput, parseReviewPassedOutput } from './output-selectors.js';
import { OrchestratorError, type OrchestratorFailureCode } from '../errors.js';
import type { PullRequestCreator } from '../effects/pull-request-creator.js';
import { toMastraWorkflow, ReviewLoopMaxIterationsError } from '../../dsl/to-mastra.js';
import type {
  AdapterContext,
  AgentRunResult as AdapterAgentRunResult,
  InterpolationSource,
  ResolvedStep as AdapterResolvedStep,
  StepOutputView,
  WorkflowPrEffect,
  ResolvedWorkflow,
} from '../../workflow/types.js';
import { AdapterValidationError } from '../../dsl/dsl-errors.js';
import { StepCollaborators } from './step-collaborators.js';
import { PullRequestExternalEffect } from './pull-request-external-effect.js';
import { BranchPublicationExternalEffect } from './branch-publication-external-effect.js';
import type { BranchPublisher } from '../effects/branch-publisher.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export type TaskId = string;

export interface TaskInput {
  title: string;
  description: string;
  source: Task['source'];
  externalRef?: Task['external_ref'];
  issueNumber?: number | null;
}

export interface RunOpts {
  workflowId?: string;
  agentOverrides?: Record<string, string>;
  vars?: Record<string, string>;
}

export interface PipelineEngine {
  runFull(projectId: string, input: TaskInput, opts?: RunOpts): Promise<TaskId>;
  runNextStep(taskId: TaskId): Promise<void>;
  pause(taskId: TaskId): Promise<void>;
  resume(taskId: TaskId): Promise<void>;
  cancel(taskId: TaskId): Promise<void>;
  recoverPending(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Seams for not-yet-built modules (Reporter / ForgeMap) — issues own the real
// implementations; tests inject fakes (per the #8 task brief).
// ---------------------------------------------------------------------------

/**
 * Minimal ForgeMap seam. The real ForgeMap/ContextSelector (separate issue)
 * stages selected-forgemap.md / target-profile.md / docs into the worktree
 * `.forgeroom/context/`. Here the engine only needs the staging hook to run
 * after worktree bootstrap and before the Mastra run starts.
 */
export interface ForgeMapStager {
  stage(input: { taskId: string; worktreePath: string; projectId: string }): Promise<void>;
}

/** Pluggable Mastra storage + snapshot bridge (proven OQ-M01 pattern). */
export interface MastraSnapshotBridge {
  /** Read the durable snapshot for a run, or null when absent. */
  load(runId: string): Promise<WorkflowRunState | null>;
  /** Persist a snapshot so a fresh process/store can resume it. */
  save(runId: string, workflowName: string, snapshot: WorkflowRunState): Promise<void>;
}

/**
 * GitHub coordinates for a task's PR external effect (ADR-019). Resolved by the
 * composition root (#30) — core never derives owner/repo from `ProjectMeta`
 * (which is provider-agnostic). `null` means the project has no PR target
 * configured, so the effect is skipped even when `effects.external.pr != none`.
 */
export interface PullRequestTarget {
  owner: string;
  repo: string;
  /** Base branch the PR merges into. */
  base: string;
}

export interface PipelineEngineDeps {
  projectRegistry: ProjectRegistry;
  workflowRegistry: WorkflowRegistry;
  intentRegistry: IntentRegistry;
  taskStore: TaskStore;
  worktreeManager: WorktreeManager;
  agentRunner: AgentRunner;
  checkRunner: { run(request: CheckRunnerRequest): Promise<CheckRunResult> };
  conductor: Conductor;
  approvalGate: ApprovalGate;
  /**
   * Reporter facade (ADR-013): the engine fires `notify(event)` AFTER the
   * authoritative TaskStore commit. The real OutboxReporter lives in
   * `reporter.ts`; tests inject a fake. (`flushUndelivered` is part of the
   * contract but only the composition root / restart path calls it.)
   */
  reporter: Reporter;
  forgeMap: ForgeMapStager;
  snapshotBridge: MastraSnapshotBridge;
  /**
   * PR external effect (ADR-019). Runs after workflow/check success and before
   * task `done`, only when the workflow's `effects.external.pr != none` AND a PR
   * target is resolved. Both are optional so projects/workflows without PR
   * automation (and existing tests) need no wiring; the gateway-backed
   * PullRequestCreator + target resolver are wired at the composition root (#30).
   */
  pullRequestCreator?: PullRequestCreator;
  prTargetFor?: (input: { task: Task; project: ProjectMeta }) => PullRequestTarget | null;
  /**
   * Branch-publication external effect (ADR-025). Runs BEFORE the PR effect in
   * the success path: commits worktree changes and pushes the branch. Optional
   * so existing tests without git wiring still work; when absent the engine skips
   * directly to PR creation. When the worktree has no diff the engine skips PR
   * creation, emits `task_done_no_diff`, and marks the task done.
   */
  branchPublisher?: BranchPublisher;
  /** Where worktrees may be created (passed to ApprovalGate worktree check). */
  allowedWorktreeRoots: string[];
  /** Resolves the absolute worktree path for a new task. */
  worktreePathFor(input: { taskId: string; projectId: string; branch: string }): string;
  /** Branch name for a new task. */
  branchFor(input: { taskId: string; projectId: string; title: string }): string;
  mastraVersion: string;
  createTaskId?: () => string;
  createStepRowId?: () => string;
  createEventId?: () => string;
  now?: () => Date;
  /** Logger sink; defaults to stderr. */
  log?: (line: string) => void;
}

export class GateAdmissionError extends OrchestratorError {
  constructor(
    message: string,
    readonly category: string,
    readonly gateReason: string,
  ) {
    // Admission denial is a workflow-level guard; surface it as git_conflict's
    // sibling: there is no dedicated admission failure code, so callers treat
    // this as a thrown error rather than a recorded failure_reason.
    super('agent_error', message);
    this.name = 'GateAdmissionError';
  }
}

// ---------------------------------------------------------------------------
// Default snapshot bridge: InMemoryStore + on-disk JSON (OQ-M01 proven path).
// ---------------------------------------------------------------------------

/**
 * Couples a per-engine InMemoryStore with a disk directory of snapshot JSON.
 * Cross-process resume rehydrates the store from disk before `run.resume()`.
 * Production may swap a durable store; the seam keeps the engine agnostic.
 */
export class FileSnapshotBridge implements MastraSnapshotBridge {
  constructor(private readonly dir: string) {}

  async load(runId: string): Promise<WorkflowRunState | null> {
    try {
      const raw = await readFile(this.snapshotPath(runId), 'utf8');
      const payload = JSON.parse(raw) as { snapshot: WorkflowRunState };
      return payload.snapshot;
    } catch {
      return null;
    }
  }

  async save(runId: string, workflowName: string, snapshot: WorkflowRunState): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.snapshotPath(runId), JSON.stringify({ workflowName, runId, snapshot }));
  }

  private snapshotPath(runId: string): string {
    return path.join(this.dir, `${runId}.json`);
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

const MASTRA_WORKFLOW_DOMAIN = 'workflows';

export class MastraPipelineEngine implements PipelineEngine {
  private readonly deps: PipelineEngineDeps;
  private readonly createTaskId: () => string;
  private readonly createStepRowId: () => string;
  private readonly createEventId: () => string;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly prEffect: PullRequestExternalEffect;
  private readonly branchEffect: BranchPublicationExternalEffect;
  /** Cooperative pause intents keyed by task id (codex-confirmed mechanism). */
  private readonly pauseRequested = new Set<string>();

  constructor(deps: PipelineEngineDeps) {
    this.deps = deps;
    this.createTaskId = deps.createTaskId ?? randomUUID;
    this.createStepRowId = deps.createStepRowId ?? randomUUID;
    this.createEventId = deps.createEventId ?? randomUUID;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.prEffect = new PullRequestExternalEffect({
      ...(deps.pullRequestCreator === undefined ? {} : { pullRequestCreator: deps.pullRequestCreator }),
      ...(deps.prTargetFor === undefined ? {} : { prTargetFor: deps.prTargetFor }),
      taskStore: deps.taskStore,
      reporter: deps.reporter,
      log: this.log,
    });
    this.branchEffect = new BranchPublicationExternalEffect({
      ...(deps.branchPublisher === undefined ? {} : { branchPublisher: deps.branchPublisher }),
      log: this.log,
    });
  }

  // -------------------------------------------------------------------------
  // runFull — sole entry from TaskSources.
  // -------------------------------------------------------------------------

  async runFull(projectId: string, input: TaskInput, opts: RunOpts = {}): Promise<TaskId> {
    const project = this.requireProject(projectId);
    const workflowId = opts.workflowId ?? project.default_workflow;
    if (!project.allowed_workflows.includes(workflowId)) {
      throw new GateAdmissionError(
        `workflow ${workflowId} not allowed for project ${projectId}`,
        'workflow',
        'workflow_not_allowed',
      );
    }

    const taskId = this.createTaskId();
    const branch = this.deps.branchFor({ taskId, projectId, title: input.title });
    const worktreePath = this.deps.worktreePathFor({ taskId, projectId, branch });

    // ApprovalGate admission (pre-Mastra). TaskSources cannot bypass this.
    const worktreeDecision = this.deps.approvalGate.checkWorktreeCreation(
      { branch, worktreePath, allowedWorktreeRoots: this.deps.allowedWorktreeRoots },
      project,
    );
    if (!worktreeDecision.allowed) {
      throw new GateAdmissionError(
        `worktree creation denied: ${worktreeDecision.reason ?? 'unknown'}`,
        worktreeDecision.category ?? 'workflow',
        worktreeDecision.reason ?? 'denied',
      );
    }

    // Create the authoritative task row (running) up front.
    const createInput: CreateTaskInput = {
      id: taskId,
      project_id: projectId,
      workflow_id: workflowId,
      title: input.title,
      description: input.description,
      status: 'running',
      source: input.source,
      external_ref: input.externalRef ?? null,
      issue_number: input.issueNumber ?? null,
      branch_name: branch,
      worktree_path: worktreePath,
      pr_number: null,
      final_slices: [],
      vars: opts.vars ?? {},
    };
    const task = await this.deps.taskStore.startTask(createInput);

    // WorktreeManager bootstrap (creates worktree + .forgeroom/ skeleton).
    await this.deps.worktreeManager.create(task);
    await this.deps.conductor.init(taskId);

    // ForgeMap staging (real impl is a separate issue; seam runs here).
    await this.deps.forgeMap.stage({ taskId, worktreePath, projectId });

    await this.deps.reporter.notify({ type: 'task_started', task });

    // Build the Mastra workflow via the #6 adapter and start the run.
    await this.startRun({ task, project, opts });

    return taskId;
  }

  // -------------------------------------------------------------------------
  // runNextStep — run exactly the next executable step. In the Mastra model a
  // single autonomous run advances to the next suspension/terminal point, so
  // "next step" maps to resuming a suspended run (or starting one). Arbitrary
  // step targeting is intentionally unsupported (pipeline-engine.md).
  // -------------------------------------------------------------------------

  async runNextStep(taskId: TaskId): Promise<void> {
    await this.resume(taskId);
  }

  // -------------------------------------------------------------------------
  // pause — cooperative. We cannot preempt a running `run.start()` mid-step;
  // the only durable suspension points are the adapter's pauseAfterGate steps.
  // So pause records intent and flips status to 'paused' once the run actually
  // resolves at a checkpoint (codex-confirmed: paused must reflect real
  // suspension, not requested suspension).
  // -------------------------------------------------------------------------

  async pause(taskId: TaskId): Promise<void> {
    const task = await this.requireTask(taskId);
    if (task.status !== 'running') {
      return;
    }
    this.pauseRequested.add(taskId);
    // If the run is already suspended at a gate, mark paused immediately.
    const runId = await this.deps.taskStore.getMastraRunId(taskId);
    if (runId !== null && (await this.deps.snapshotBridge.load(runId)) !== null) {
      await this.deps.taskStore.updateTaskStatus(taskId, 'paused');
    }
  }

  // -------------------------------------------------------------------------
  // resume — flip to running, then either resume the suspended Mastra run or
  // start a fresh reconstructed run (#9 completes the full hybrid; #8 covers
  // the common suspended-snapshot case + an explicit fresh-run fallback).
  // -------------------------------------------------------------------------

  async resume(taskId: TaskId): Promise<void> {
    const task = await this.requireTask(taskId);
    if (task.status === 'canceled') {
      throw new OrchestratorError('agent_error', `task ${taskId} is canceled and cannot be resumed`);
    }
    if (task.status === 'done' || task.status === 'failed') {
      return;
    }

    this.pauseRequested.delete(taskId);
    await this.deps.taskStore.updateTaskStatus(taskId, 'running');

    const project = this.requireProject(task.project_id);
    const runId = await this.deps.taskStore.getMastraRunId(taskId);

    if (runId !== null && (await this.deps.snapshotBridge.load(runId)) !== null) {
      await this.resumeRun({ task, project, runId });
      return;
    }

    // Fresh run fallback: no usable snapshot → reconstruct from TaskStore.
    await this.startRun({ task, project, opts: { vars: task.vars } });
  }

  // -------------------------------------------------------------------------
  // cancel — immediate; preserves worktree/branch/PR (pipeline-engine.md).
  // -------------------------------------------------------------------------

  async cancel(taskId: TaskId): Promise<void> {
    const task = await this.deps.taskStore.getTask(taskId);
    if (task === null || task.status === 'canceled' || task.status === 'done' || task.status === 'failed') {
      return;
    }
    this.pauseRequested.delete(taskId);
    const eventId = this.createEventId();
    await this.deps.taskStore.cancelTask(taskId, eventId, { reason: 'user_canceled' });
    await this.deps.reporter.notify({ type: 'task_canceled', task: { ...task, status: 'canceled' } });
  }

  // -------------------------------------------------------------------------
  // recoverPending — hybrid restart recovery (#9, ADR-017).
  //
  // TaskStore step rows are THE authority on what runs next; the Mastra run
  // snapshot is auxiliary and consulted ONLY to choose between `run.resume()`
  // and a FRESH reconstructed run. On startup we enumerate active
  // (running/paused) tasks and, for each, pick a recovery branch:
  //
  //   1. Latest effective step state is `failed` -> leave for the user; no run.
  //   2. mastra_run_id present, a durable snapshot exists, the snapshot is
  //      `suspended`, and every output file the snapshot points at still exists
  //      on disk (FILE-WINS pointer check) -> `run.resume()`. Mastra restores
  //      control-flow/loop position; our adapter threads `iteration`, so
  //      review_loop re-entry is handled by resume, not hand-driven here.
  //   3. Otherwise (no run id, no/non-suspended snapshot, a `.forgeroom/outputs`
  //      file the snapshot referenced is gone, or any inconsistency) -> discard
  //      the snapshot and start a FRESH run from step 1. Worker bodies are
  //      idempotent (re-render prompt -> re-run agent -> re-write output ->
  //      re-run checks), so replay reconstructs the same state. The TaskStore
  //      next-step pointer is never derived FROM the snapshot.
  //
  // The worktree `.forgeroom/` skeleton is re-bootstrapped first if missing, so
  // recovery is idempotent even after a worktree was rebuilt.
  // -------------------------------------------------------------------------

  async recoverPending(): Promise<void> {
    const active = await this.deps.taskStore.listActiveTasks();
    for (const task of active) {
      try {
        await this.recoverTask(task);
      } catch (error) {
        // One task's recovery failure must not abort the rest. Record the
        // failure on the task row (authoritative) and continue.
        const reason = mapFailureReason(error);
        this.log(`recoverPending: task ${task.id} recovery failed (${reason})`);
        await this.deps.taskStore.updateTaskStatus(task.id, 'failed', reason);
      }
    }
  }

  private async recoverTask(task: Task): Promise<void> {
    const project = this.requireProject(task.project_id);

    // The latest effective step state is authoritative for the failed guard.
    const steps = await this.deps.taskStore.listSteps(task.id);
    if (latestStepIsFailed(steps)) {
      // Leave for the user; do NOT auto-restart (pipeline-engine.md).
      this.log(`recoverPending: task ${task.id} last step failed; leaving for user`);
      return;
    }

    // Re-bootstrap the worktree `.forgeroom/` skeleton if it vanished.
    await this.ensureWorktreeBootstrapped(task);

    const runId = await this.deps.taskStore.getMastraRunId(task.id);
    if (runId !== null && (await this.canResumeSnapshot(runId))) {
      this.log(`recoverPending: task ${task.id} resuming suspended Mastra run ${runId}`);
      await this.resumeRun({ task, project, runId });
      return;
    }

    // Fresh run: discard the auxiliary snapshot and replay from step 1.
    this.log(`recoverPending: task ${task.id} starting fresh reconstructed run`);
    await this.startRun({ task, project, opts: { vars: task.vars } });
  }

  /**
   * A snapshot is resumable when it is durable, `suspended`, and every output
   * file it references still exists on disk. The last clause is the FILE-WINS
   * reconciliation: the on-disk `.forgeroom/outputs/NN_<step_id>.md` is the
   * authority, and the snapshot only stores file PATHS (not content), so a
   * missing referenced file means the snapshot is stale -> fresh run.
   */
  private async canResumeSnapshot(runId: string): Promise<boolean> {
    const snapshot = await this.deps.snapshotBridge.load(runId);
    if (snapshot === null || snapshot.status !== 'suspended') {
      return false;
    }
    for (const outputPath of collectSnapshotOutputPaths(snapshot)) {
      if (!(await fileExists(outputPath))) {
        return false;
      }
    }
    return true;
  }

  /** Re-create the `.forgeroom/` skeleton if the worktree lost it. */
  private async ensureWorktreeBootstrapped(task: Task): Promise<void> {
    const marker = path.join(task.worktree_path, '.forgeroom');
    if (await dirExists(marker)) {
      return;
    }
    await this.deps.worktreeManager.create(task);
  }

  // -------------------------------------------------------------------------
  // Internal: build + start a fresh Mastra run.
  // -------------------------------------------------------------------------

  private async startRun(input: { task: Task; project: ProjectMeta; opts: RunOpts }): Promise<void> {
    const { task, project } = input;
    const built = this.buildWorkflow({ task, project, opts: input.opts });
    const { mastra, workflowName } = this.makeMastra(built.workflow);
    const wf = mastra.getWorkflow(workflowName);

    const run = await wf.createRun();
    // ADR-017 / codex(94): record the run id BEFORE start() so a crash mid-run
    // leaves a recoverable pointer.
    await this.deps.taskStore.setMastraRunId(task.id, run.runId);

    const result = await run.start({ inputData: {} });
    await this.persistSnapshot(mastra, workflowName, run.runId);
    await this.settle({ task, project, result: normalizeResult(result), prEffect: built.prEffect });
  }

  private async resumeRun(input: { task: Task; project: ProjectMeta; runId: string }): Promise<void> {
    const { task, project, runId } = input;
    const built = this.buildWorkflow({ task, project, opts: { vars: task.vars } });
    const { mastra, workflowName } = this.makeMastra(built.workflow);

    // Rehydrate the durable snapshot into this fresh store before resuming.
    const snapshot = await this.deps.snapshotBridge.load(runId);
    if (snapshot === null) {
      // Snapshot vanished between the check and here → fresh run.
      await this.startRun({ task, project, opts: { vars: task.vars } });
      return;
    }
    const store = await mastra.getStorage()?.getStore(MASTRA_WORKFLOW_DOMAIN);
    if (store !== undefined && store !== null) {
      await (store as WorkflowSnapshotStore).persistWorkflowSnapshot({
        workflowName,
        runId,
        snapshot,
      });
    }

    const wf = mastra.getWorkflow(workflowName);
    const run = await wf.createRun({ runId });
    const result = await run.resume({ resumeData: { resumed: true } });
    await this.persistSnapshot(mastra, workflowName, runId);
    await this.settle({ task, project, result: normalizeResult(result), prEffect: built.prEffect });
  }

  /** Translate a Mastra run result into authoritative TaskStore status. */
  private async settle(input: {
    task: Task;
    project: ProjectMeta;
    result: MastraRunResult;
    prEffect: WorkflowPrEffect;
  }): Promise<void> {
    const { task, project, result, prEffect } = input;
    if (result.status === 'success') {
      this.pauseRequested.delete(task.id);
      // External-effect phase (ADR-025 then ADR-019):
      //   1. Branch publication (commit + push) — task-critical, runs first.
      //   2. PR creation — task-critical, runs only when there was a diff.
      // A final failure in either step fails the task.

      // Step 1: branch publication.
      let branchResult;
      try {
        branchResult = await this.branchEffect.run({ task });
      } catch (error) {
        const reason = mapFailureReason(error);
        await this.deps.taskStore.updateTaskStatus(task.id, 'failed', reason);
        await this.deps.reporter.notify({
          type: 'task_failed',
          task: { ...task, status: 'failed', failure_reason: reason },
          failure_reason: reason,
        });
        return;
      }

      // Step 2: no-diff terminal success — skip PR, emit event, done.
      if (branchResult.noDiff) {
        await this.deps.taskStore.updateTaskStatus(task.id, 'done');
        await this.deps.reporter.notify({
          type: 'task_done_no_diff',
          task: { ...task, status: 'done' },
        });
        return;
      }

      // Step 3: PR creation (ADR-019).
      try {
        await this.prEffect.run({ task, project, prEffect });
      } catch (error) {
        const reason = mapFailureReason(error);
        await this.deps.taskStore.updateTaskStatus(task.id, 'failed', reason);
        await this.deps.reporter.notify({
          type: 'task_failed',
          task: { ...task, status: 'failed', failure_reason: reason },
          failure_reason: reason,
        });
        return;
      }
      await this.deps.taskStore.updateTaskStatus(task.id, 'done');
      return;
    }
    if (result.status === 'suspended') {
      // A suspended run is a pause checkpoint regardless of whether the user
      // explicitly requested it (pause_after gate or cooperative pause).
      this.pauseRequested.delete(task.id);
      await this.deps.taskStore.updateTaskStatus(task.id, 'paused');
      return;
    }
    // failed: map adapter/runtime failure to a recorded failure_reason.
    const reason = mapFailureReason(result.error);
    await this.deps.taskStore.updateTaskStatus(task.id, 'failed', reason);
    await this.deps.reporter.notify({
      type: 'task_failed',
      task: { ...task, status: 'failed', failure_reason: reason },
      failure_reason: reason,
    });
  }

  private async persistSnapshot(mastra: Mastra, workflowName: string, runId: string): Promise<void> {
    const store = await mastra.getStorage()?.getStore(MASTRA_WORKFLOW_DOMAIN);
    if (store === undefined || store === null) {
      return;
    }
    const snapshot = await (store as WorkflowSnapshotStore).loadWorkflowSnapshot({ workflowName, runId });
    if (snapshot !== null && snapshot !== undefined) {
      await this.deps.snapshotBridge.save(runId, workflowName, snapshot);
    }
  }

  // -------------------------------------------------------------------------
  // Build the Mastra workflow + AdapterContext for a task.
  // -------------------------------------------------------------------------

  private buildWorkflow(input: { task: Task; project: ProjectMeta; opts: RunOpts }) {
    const { task, project } = input;
    const workflow = this.deps.workflowRegistry.get(task.workflow_id);
    if (workflow === null || workflow.executableSteps === undefined) {
      throw new AdapterValidationError(`workflow not found: ${task.workflow_id}`, task.workflow_id);
    }

    const ctx = this.buildAdapterContext({ task, project, opts: input.opts });
    const built = toMastraWorkflow(workflow as ResolvedWorkflow, ctx);
    return { ...built, prEffect: workflow.effects.external.pr };
  }

  private buildAdapterContext(input: {
    task: Task;
    project: ProjectMeta;
    opts: RunOpts;
  }): AdapterContext {
    const { task, project } = input;
    // Per-run mutable view of prior step outputs (filled as steps complete).
    const stepOutputs: Record<string, StepOutputView> = {};
    // Monotonic file-index counter for NN_<step_id>.md naming.
    const stepCounter = { value: 0 };

    const interpolation: InterpolationSource = {
      task: {
        title: task.title,
        description: task.description,
        project: task.project_id,
        branch: task.branch_name,
        worktree_path: task.worktree_path,
        issue_number: task.issue_number === null ? '' : String(task.issue_number),
        full_diff_path: path.join('.forgeroom', 'diffs', 'full.diff'),
        final_slices: task.final_slices,
      },
      vars: { ...task.vars, ...(input.opts.vars ?? {}) },
      stepOutputs,
    };

    const agentOverrides = input.opts.agentOverrides ?? {};
    const promptIndex = new Map<string, { index: number; fileBase: string }>();
    const collaborators = new StepCollaborators({
      task,
      project,
      interpolation,
      stepOutputs,
      stepCounter,
      promptIndex,
      agentOverrides,
      deps: {
        conductor: this.deps.conductor,
        approvalGate: this.deps.approvalGate,
        agentRunner: this.deps.agentRunner,
        checkRunner: this.deps.checkRunner,
        taskStore: this.deps.taskStore,
      },
      callbacks: {
        recordStepRow: (args) => this.recordStepRow(args),
        createStepRowId: () => this.createStepRowId(),
        now: () => this.now(),
        notifyStepDone: (event) => this.deps.reporter.notify(event),
        log: this.log,
      },
    });

    return {
      interpolation,
      collaborators: collaborators.asAdapterCollaborators(),
      selectors: {
        parseSlices: (output: string): string[] => parseSlicesOutput(output),
        parseReviewPassed: (output: string): boolean => parseReviewPassedOutput(output),
      },
    };
  }

  private async recordStepRow(input: {
    task: Task;
    resolved: AdapterResolvedStep;
    run: AdapterAgentRunResult;
  }): Promise<Step> {
    const { task, resolved, run } = input;
    const now = this.now();
    const step: Step = {
      id: this.createStepRowId(),
      task_id: task.id,
      step_id: resolved.stepId,
      parent_step_id: null,
      iteration: 0,
      agent_id: resolved.agent,
      status: 'running',
      failure_reason: null,
      attempt: 1,
      check_fix_attempt: 0,
      check_status: 'not_run',
      prompt_path: '',
      output_path: run.outputPath,
      diff_path: run.diffPath,
      exit_code: 0,
      started_at: now,
      finished_at: null,
    };
    return this.deps.taskStore.createStep(step);
  }

  private makeMastra(workflow: unknown): { mastra: Mastra; workflowName: string } {
    // The committed workflow carries its own id; register it by that id.
    const workflowName = (workflow as { id: string }).id;
    const mastra = new Mastra({
      storage: new InMemoryStore(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      workflows: { [workflowName]: workflow as any },
      logger: false,
    });
    return { mastra, workflowName };
  }

  private requireProject(projectId: string): ProjectMeta {
    const project = this.deps.projectRegistry.get(projectId);
    if (project === null) {
      throw new OrchestratorError('agent_error', `unknown project: ${projectId}`);
    }
    return project;
  }

  private async requireTask(taskId: string): Promise<Task> {
    const task = await this.deps.taskStore.getTask(taskId);
    if (task === null) {
      throw new OrchestratorError('agent_error', `unknown task: ${taskId}`);
    }
    return task;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MastraRunResult {
  status: 'success' | 'suspended' | 'failed';
  result?: unknown;
  error?: unknown;
  suspended?: unknown;
}

/**
 * Normalize a Mastra `run.start()/resume()` result into the three statuses the
 * engine acts on. Mastra also has a `tripwire` status (a guard short-circuit);
 * we treat it as a failure so it records a failure_reason rather than silently
 * completing.
 */
function normalizeResult(result: { status: string; error?: unknown; result?: unknown }): MastraRunResult {
  if (result.status === 'success' || result.status === 'suspended') {
    return { status: result.status, result: result.result };
  }
  return { status: 'failed', error: result.error };
}

interface WorkflowSnapshotStore {
  loadWorkflowSnapshot(input: {
    workflowName: string;
    runId: string;
  }): Promise<WorkflowRunState | null>;
  persistWorkflowSnapshot(input: {
    workflowName: string;
    runId: string;
    snapshot: WorkflowRunState;
  }): Promise<void>;
}

/**
 * Whether the LATEST effective state of the most-recently-started step is
 * `failed`. Step rows are read in started_at order (sparse: only kind:execute
 * steps create rows). "Latest effective" means the last row per step_id, so a
 * later successful re-attempt of a step supersedes an earlier failed row and
 * the task is NOT treated as failed. Absence of any row is NOT a failure.
 */
function latestStepIsFailed(steps: Step[]): boolean {
  // The most-recently-started step overall decides the guard. Rows arrive in
  // started_at ascending order, and a later row for the same step_id supersedes
  // an earlier one, so the final element already reflects the latest effective
  // state of the latest step.
  const last = steps.at(-1);
  if (last === undefined) {
    return false;
  }
  return last.status === 'failed';
}

/**
 * Collect every `.forgeroom/outputs/...` path the snapshot's recorded step
 * results reference. The snapshot stores StepExecution outputs (with an
 * `outputPath`) under `context[mastraStepId].output`; we treat each as a
 * pointer to a file the on-disk authority must still hold.
 */
function collectSnapshotOutputPaths(snapshot: WorkflowRunState): string[] {
  const paths: string[] = [];
  const context = snapshot.context as Record<string, unknown> | undefined;
  if (context === undefined || context === null) {
    return paths;
  }
  for (const [key, entry] of Object.entries(context)) {
    if (key === 'input' || entry === null || typeof entry !== 'object') {
      continue;
    }
    const output = (entry as { output?: unknown }).output;
    collectOutputPathsFrom(output, paths);
  }
  return paths;
}

/** A step output may be a single StepExecution or an array (foreach item). */
function collectOutputPathsFrom(output: unknown, into: string[]): void {
  if (Array.isArray(output)) {
    for (const element of output) {
      collectOutputPathsFrom(element, into);
    }
    return;
  }
  if (output !== null && typeof output === 'object') {
    const outputPath = (output as { outputPath?: unknown }).outputPath;
    if (typeof outputPath === 'string' && outputPath.length > 0) {
      into.push(outputPath);
    }
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

function mapFailureReason(error: unknown): OrchestratorFailureCode {
  if (error instanceof ReviewLoopMaxIterationsError) {
    return 'review_loop_max_iterations';
  }
  if (error instanceof AdapterValidationError) {
    // adapter_validation_failed is not in core's union (#6 flag); map to the
    // closest runtime code at the boundary rather than promoting the union.
    return 'output_contract_failed';
  }
  if (error instanceof OrchestratorError) {
    return error.code;
  }
  return 'agent_error';
}
