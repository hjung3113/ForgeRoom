/**
 * recoverPending() hybrid restart-recovery integration tests (#9, ADR-017).
 *
 * Real SQLite (temp file), temp `.forgeroom/`, FAKE AgentRunner / CheckRunner /
 * Reporter / ForgeMap / Conductor per testing-rules. Covers the resume-vs-fresh
 * decision, FILE-WINS reconciliation, the failed-step guard, paused control
 * step (review_loop) re-entry, and idempotent worktree re-bootstrap.
 *
 * The decision under test is ONLY "resume the suspended Mastra run vs. start a
 * fresh reconstructed run"; TaskStore step rows are authoritative for the
 * next-step pointer (no path consults the snapshot as the authority).
 */
import { mkdtemp, readFile, rm, stat, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createTaskStoreDatabase,
  migrateTaskStoreDatabase,
  type TaskStoreDatabase,
} from '../../src/db/client.js';
import { SqliteTaskStore } from '../../src/db/sqlite-task-store.js';
import { IntentRegistry } from '../../src/core/registries/intent-registry.js';
import { ProjectRegistry } from '../../src/core/registries/project-registry.js';
import { WorkflowRegistry } from '../../src/core/registries/workflow-registry.js';
import { parseWorkflowConfig } from '../../src/dsl/workflow-parser.js';
import { mastraWorkflowBuilder } from '../../src/dsl/to-mastra.js';
import { AgentRegistry } from '../../src/core/agent-runtime/agent-registry.js';
import { HarnessRegistry } from '../../src/core/agent-runtime/harness-registry.js';
import { ApprovalGate } from '../../src/core/checks/approval-gate.js';
import type { AgentRunner, AgentRunResult } from '../../src/core/agent-runtime/agent-runner.js';
import type { CheckRunResult } from '../../src/core/types.js';
import type { Conductor, Reporter, ReporterEvent, StepResult, Task } from '../../src/core/types.js';
import type { CheckRunnerRequest } from '../../src/core/checks/check-runner.js';
import {
  MastraPipelineEngine,
  FileSnapshotBridge,
  type ForgeMapStager,
  type PipelineEngineDeps,
} from '../../src/core/engine/pipeline-engine.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const INTENTS = {
  write_plan: { kind: 'write_plan', agent: 'planner', harness: 'planning' },
  implement: { kind: 'execute', agent: 'coder', harness: 'implementation' },
  review_code: { kind: 'review', agent: 'reviewer', harness: 'review' },
};

// plan -> foreach build -> wrapup(pause_after). The pause gate makes the run
// suspend so we can simulate a process kill at a durable checkpoint.
const WORKFLOW_PAUSE_YAML = `
mvp:
  description: test workflow
  effects:
    worktree: modifies
    external:
      report: status
      pr: draft
  steps:
    - type: run
      id: plan
      intent: write_plan
      prompt_template: plan.md
      output_selectors: [slices]
    - type: group
      id: build
      foreach: \${task.final_slices}
      as: slice
      steps:
        - type: run
          id: slice_impl
          intent: implement
          prompt_template: impl.md
          input_refs:
            slice: \${slice}
    - type: run
      id: wrapup
      intent: write_plan
      prompt_template: wrap.md
      pause_after: true
`;

// Same steps but NO trailing pause gate: a fresh replay runs to completion
// ('done') rather than re-suspending. Used for the fresh-branch tests.
const WORKFLOW_NO_PAUSE_YAML = `
mvp:
  description: no-pause workflow
  effects:
    worktree: modifies
    external:
      report: status
      pr: draft
  steps:
    - type: run
      id: plan
      intent: write_plan
      prompt_template: plan.md
      output_selectors: [slices]
    - type: group
      id: build
      foreach: \${task.final_slices}
      as: slice
      steps:
        - type: run
          id: slice_impl
          intent: implement
          prompt_template: impl.md
          input_refs:
            slice: \${slice}
`;

// A review_loop workflow (a control step). The loop refines once then passes.
// A fresh replay re-runs the whole loop idempotently to completion.
const WORKFLOW_REVIEW_LOOP_YAML = `
mvp:
  description: review loop workflow
  effects:
    worktree: modifies
    external:
      report: status
      pr: draft
  steps:
    - type: run
      id: plan
      intent: write_plan
      prompt_template: plan.md
      output_selectors: [slices]
    - type: review_loop
      id: review
      until: \${do_review.passed}
      max_iterations: 3
      review:
        id: do_review
        intent: review_code
        prompt_template: review.md
      refine:
        id: do_refine
        intent: implement
        prompt_template: refine.md
`;

const PLAN_OUTPUT = '# Plan\n\n## Slices\n\n- first slice\n- second slice\n';
const REVIEW_FAIL_OUTPUT = 'Review Result: fail\n\nmore work needed (padding bytes here).';
const REVIEW_PASS_OUTPUT = 'Review Result: pass\n\nlooks good now (padding bytes here too).';

interface Harness {
  store: SqliteTaskStore;
  database: TaskStoreDatabase;
  worktreeRoot: string;
  worktreePath: string;
  snapshotDir: string;
  reporterEvents: ReporterEvent[];
  agentCalls: string[];
  deps: PipelineEngineDeps;
  /** Build a brand-new engine (simulated process restart). */
  rebuild: (overrides?: Partial<PipelineEngineDeps>) => MastraPipelineEngine;
  cleanup: () => Promise<void>;
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'recover-int-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function buildWorkflowRegistry(yaml: string): { workflowRegistry: WorkflowRegistry; intents: IntentRegistry } {
  const harnessRegistry = HarnessRegistry.fromConfig({
    planning: { source: 'harnesses/planning.md' },
    implementation: { source: 'harnesses/implementation.md' },
    review: { source: 'harnesses/review.md' },
  });
  const agentRegistry = AgentRegistry.fromConfig(
    {
      planner: { provider: 'openclaw', runtime: 'r', model: 'm', harness: 'planning' },
      coder: { provider: 'openclaw', runtime: 'r', model: 'm', harness: 'implementation' },
      reviewer: { provider: 'openclaw', runtime: 'r', model: 'm', harness: 'review' },
    },
    harnessRegistry,
  );
  const intentRegistry = IntentRegistry.fromConfig(INTENTS);
  const parsedWorkflow = parseWorkflowConfig(yaml);
  const workflowRegistry = WorkflowRegistry.fromConfig(
    parsedWorkflow.config,
    { intentRegistry, agentRegistry, harnessRegistry },
    { templateExists: () => true },
  );
  return { workflowRegistry, intents: intentRegistry };
}

function buildProjectRegistry(projectPath: string, workflowRegistry: WorkflowRegistry): ProjectRegistry {
  return ProjectRegistry.fromConfig(
    {
      proj: {
        path: projectPath,
        default_branch: 'main',
        package_manager: 'pnpm',
        default_workflow: 'mvp',
        allowed_workflows: ['mvp'],
        commands: { lint: 'echo lint', typecheck: 'echo tc', test: 'echo test' },
        maintainers: { discord_user_ids: [], github_logins: [] },
      },
    },
    workflowRegistry,
    { projectPathExists: () => true },
  );
}

/** Fake AgentRunner: writes the body's output file with per-step content. */
function makeFakeAgentRunner(
  agentCalls: string[],
  outputs: Record<string, string>,
  reviewState: { calls: number },
): AgentRunner {
  return {
    async run(req): Promise<AgentRunResult> {
      agentCalls.push(req.agentId);
      const base = path.basename(req.outputPath, '.md');
      const stepId = base.replace(/^\d+_/, '');
      let content: string;
      if (stepId === 'do_review') {
        // First review fails, the next passes (after one refine iteration).
        reviewState.calls += 1;
        content = reviewState.calls >= 2 ? REVIEW_PASS_OUTPUT : REVIEW_FAIL_OUTPUT;
      } else {
        content = outputs[stepId] ?? `# ${stepId}\n\nautomated output for ${stepId} (>=50 bytes padding).`;
      }
      await mkdir(path.dirname(req.outputPath), { recursive: true });
      await writeFile(req.outputPath, content);
      return {
        exitCode: 0,
        outputExists: true,
        outputBytes: Buffer.byteLength(content),
        durationMs: 1,
        sessionId: null,
        stdoutPath: req.stdoutPath,
        stderrPath: req.stderrPath,
      };
    },
    async resume(req): Promise<AgentRunResult> {
      return this.run(req);
    },
  };
}

function makeFakeConductor(): Conductor {
  return {
    init: async (): Promise<void> => Promise.resolve(),
    update: async (_t: string, _sr: StepResult): Promise<void> => Promise.resolve(),
    integrateFeedback: async (): Promise<void> => Promise.resolve(),
    refine: async (_t: string, _s: string, base: string): Promise<string> => base,
    answer: async (): Promise<string> => 'ok',
  };
}

async function bootstrapWorktree(worktreePath: string): Promise<void> {
  for (const dir of [
    '.forgeroom',
    '.forgeroom/context',
    '.forgeroom/prompts',
    '.forgeroom/outputs',
    '.forgeroom/diffs',
    '.forgeroom/logs',
  ]) {
    await mkdir(path.join(worktreePath, dir), { recursive: true });
  }
}

async function setup(yaml: string): Promise<Harness> {
  const projectPath = path.join(tempDir, 'project');
  await mkdir(projectPath, { recursive: true });
  const worktreeRoot = path.join(tempDir, 'worktrees');
  await mkdir(worktreeRoot, { recursive: true });

  const database = createTaskStoreDatabase(path.join(tempDir, 'forgeroom.sqlite'));
  migrateTaskStoreDatabase(database);
  const store = new SqliteTaskStore(database);

  const reporterEvents: ReporterEvent[] = [];
  const agentCalls: string[] = [];
  const reviewState = { calls: 0 };

  const agentRunner = makeFakeAgentRunner(agentCalls, { plan: PLAN_OUTPUT }, reviewState);
  const reporter: Reporter = {
    flushUndelivered: (): Promise<void> => Promise.resolve(),
    notify: async (event): Promise<void> => {
      reporterEvents.push(event);
      return Promise.resolve();
    },
  };
  const forgeMap: ForgeMapStager = { stage: async (): Promise<void> => Promise.resolve() };
  const conductor = makeFakeConductor();
  const { workflowRegistry, intents } = buildWorkflowRegistry(yaml);
  const projectRegistry = buildProjectRegistry(projectPath, workflowRegistry);
  const snapshotDir = path.join(tempDir, 'snapshots');

  const checkRunner = {
    run: async (_request: CheckRunnerRequest): Promise<CheckRunResult> =>
      ({ allPassed: true, results: [] }),
  };

  const worktreeManager = {
    create: async (task: Task): Promise<{ path: string; branch: string }> => {
      await bootstrapWorktree(task.worktree_path);
      return { path: task.worktree_path, branch: task.branch_name };
    },
    ensureForgeroomDir: async (): Promise<void> => Promise.resolve(),
  } as unknown as PipelineEngineDeps['worktreeManager'];

  const deps: PipelineEngineDeps = {
    projectRegistry,
    workflowRegistry,
    intentRegistry: intents,
    taskStore: store,
    worktreeManager,
    agentRunner,
    checkRunner,
    conductor,
    approvalGate: new ApprovalGate(),
    reporter,
    forgeMap,
    snapshotBridge: new FileSnapshotBridge(snapshotDir),
    workflowBuilder: mastraWorkflowBuilder,
    allowedWorktreeRoots: [worktreeRoot],
    worktreePathFor: ({ taskId }): string => path.join(worktreeRoot, taskId),
    branchFor: ({ taskId }): string => `feat/${taskId}`,
    mastraVersion: '1.36.0',
    createTaskId: () => 'task-1',
    log: () => {},
  };

  const worktreePath = path.join(worktreeRoot, 'task-1');

  return {
    store,
    database,
    worktreeRoot,
    worktreePath,
    snapshotDir,
    reporterEvents,
    agentCalls,
    deps,
    rebuild: (overrides?: Partial<PipelineEngineDeps>): MastraPipelineEngine =>
      new MastraPipelineEngine({
        ...deps,
        snapshotBridge: new FileSnapshotBridge(snapshotDir),
        ...overrides,
      }),
    cleanup: async (): Promise<void> => {
      database.close();
    },
  };
}

/**
 * Seed a paused task directly (no run), simulating a crash where TaskStore
 * holds the authoritative paused state but there is no usable Mastra snapshot.
 * Bootstraps the worktree skeleton so recovery's fresh replay can run.
 */
async function seedPausedTask(
  harness: Harness,
  opts: { mastraRunId?: string | null } = {},
): Promise<string> {
  const taskId = 'task-1';
  const worktreePath = path.join(harness.worktreeRoot, taskId);
  await harness.store.startTask({
    id: taskId,
    project_id: 'proj',
    workflow_id: 'mvp',
    title: 't',
    description: 'd',
    status: 'paused',
    source: 'discord-command',
    external_ref: null,
    issue_number: null,
    branch_name: `feat/${taskId}`,
    worktree_path: worktreePath,
    pr_number: null,
    final_slices: [],
    vars: {},
    mastra_run_id: opts.mastraRunId ?? null,
  });
  await bootstrapWorktree(worktreePath);
  return taskId;
}

async function startUntilPaused(harness: Harness): Promise<string> {
  const engine = new MastraPipelineEngine(harness.deps);
  const taskId = await engine.runFull('proj', {
    title: 't',
    description: 'd',
    source: 'discord-command',
  });
  const task = await harness.store.getTask(taskId);
  expect(task?.status).toBe('paused');
  return taskId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('recoverPending — resume vs fresh decision', () => {
  it('resumes when TaskStore next step matches the suspended snapshot step', async () => {
    const harness = await setup(WORKFLOW_PAUSE_YAML);
    const taskId = await startUntilPaused(harness);

    // Simulate a process kill at the pause checkpoint: brand-new engine, new
    // snapshot bridge over the SAME on-disk dir + SAME sqlite file.
    const engine2 = harness.rebuild();
    await engine2.recoverPending();

    const done = await harness.store.getTask(taskId);
    expect(done?.status).toBe('done');
    await harness.cleanup();
  });

  it('discards the snapshot and runs fresh when mastra_run_id is absent', async () => {
    // TaskStore says paused (next=plan) with NO run pointer -> resume is
    // impossible -> fresh reconstructed run from the TaskStore pointer.
    const harness = await setup(WORKFLOW_NO_PAUSE_YAML);
    const taskId = await seedPausedTask(harness, { mastraRunId: null });

    const engine2 = harness.rebuild();
    await engine2.recoverPending();

    const done = await harness.store.getTask(taskId);
    expect(done?.status).toBe('done');
    // Fresh replay re-executed steps (plan + slices) from step 1.
    expect(harness.agentCalls).toContain('planner');
    expect(harness.agentCalls.filter((a) => a === 'coder').length).toBe(2);
    await harness.cleanup();
  });

  it('discards a stale snapshot (snapshot step != TaskStore pointer) and runs fresh', async () => {
    // mastra_run_id points at a run with no loadable durable snapshot (the
    // analogue of "TaskStore next=step5 but snapshot=step3": the snapshot the
    // engine would load is unusable) -> canResumeSnapshot()=false -> fresh run.
    const harness = await setup(WORKFLOW_NO_PAUSE_YAML);
    const taskId = await seedPausedTask(harness, { mastraRunId: 'phantom-run-id' });

    const engine2 = harness.rebuild();
    await engine2.recoverPending();

    const done = await harness.store.getTask(taskId);
    expect(done?.status).toBe('done');
    await harness.cleanup();
  });
});

describe('recoverPending — FILE-WINS reconciliation', () => {
  it('discards the snapshot and runs fresh when a referenced output file is gone', async () => {
    const harness = await setup(WORKFLOW_PAUSE_YAML);
    const taskId = await startUntilPaused(harness);

    // The snapshot references .forgeroom/outputs/NN_*.md files. Delete them to
    // simulate file/snapshot contradiction; FILE WINS -> snapshot discarded.
    const outputsDir = path.join(harness.worktreePath, '.forgeroom', 'outputs');
    for (const name of await readdir(outputsDir)) {
      await rm(path.join(outputsDir, name));
    }

    const before = harness.agentCalls.length;
    const engine2 = harness.rebuild();
    await engine2.recoverPending();

    // FILE WINS: the snapshot was discarded (NOT resumed). A resume would have
    // continued past the gate to 'done' without re-running the agent; instead
    // the fresh branch replayed from step 1 (more agent calls) and the
    // pause-terminated workflow re-suspended at its gate.
    expect(harness.agentCalls.length).toBeGreaterThan(before);
    const recovered = await harness.store.getTask(taskId);
    expect(recovered?.status).toBe('paused');
    // The fresh replay re-created the output files the deletion removed.
    const planOut = await readFile(path.join(outputsDir, '01_plan.md'), 'utf8');
    expect(planOut).toContain('## Slices');
    await harness.cleanup();
  });
});

describe('recoverPending — failed-step guard', () => {
  it('leaves a task with a failed last step for the user (no run)', async () => {
    const harness = await setup(WORKFLOW_PAUSE_YAML);
    const taskId = await startUntilPaused(harness);

    // Record a trailing failed step row -> recovery must NOT auto-restart.
    await harness.store.createStep({
      id: 'failed-step',
      task_id: taskId,
      step_id: 'wrapup',
      parent_step_id: null,
      iteration: 0,
      agent_id: 'planner',
      status: 'failed',
      failure_reason: 'agent_error',
      attempt: 1,
      check_fix_attempt: 0,
      check_status: 'not_run',
      prompt_path: '',
      output_path: '',
      diff_path: null,
      exit_code: 1,
      started_at: new Date(),
      finished_at: new Date(),
    });
    const before = harness.agentCalls.length;

    const engine2 = harness.rebuild();
    await engine2.recoverPending();

    // Still paused (untouched); no new agent calls.
    const task = await harness.store.getTask(taskId);
    expect(task?.status).toBe('paused');
    expect(harness.agentCalls.length).toBe(before);
    await harness.cleanup();
  });
});

describe('recoverPending — paused control step (review_loop)', () => {
  it('recovers a paused review_loop task to completion via fresh replay', async () => {
    // A review_loop is a control step. With no usable snapshot, recovery does
    // NOT hand-drive loop re-entry; it replays the whole workflow from step 1.
    // The loop refines once (review fails then passes) and exits cleanly.
    const harness = await setup(WORKFLOW_REVIEW_LOOP_YAML);
    const taskId = await seedPausedTask(harness, { mastraRunId: null });

    const engine2 = harness.rebuild();
    await engine2.recoverPending();

    const done = await harness.store.getTask(taskId);
    expect(done?.status).toBe('done');
    // The loop ran the reviewer at least twice (fail -> refine -> pass).
    expect(harness.agentCalls.filter((a) => a === 'reviewer').length).toBeGreaterThanOrEqual(2);
    await harness.cleanup();
  });
});

describe('recoverPending — worktree re-bootstrap', () => {
  it('re-bootstraps a missing .forgeroom before running, idempotently', async () => {
    const harness = await setup(WORKFLOW_NO_PAUSE_YAML);
    const taskId = await seedPausedTask(harness, { mastraRunId: null });

    // Wipe the entire worktree: recovery must re-bootstrap the skeleton and
    // then run the fresh reconstructed run.
    await rm(harness.worktreePath, { recursive: true, force: true });

    const engine2 = harness.rebuild();
    await engine2.recoverPending();

    // Skeleton restored and the fresh run produced outputs.
    await expect(
      stat(path.join(harness.worktreePath, '.forgeroom', 'outputs')),
    ).resolves.toBeTruthy();
    const done = await harness.store.getTask(taskId);
    expect(done?.status).toBe('done');
    await harness.cleanup();
  });
});
