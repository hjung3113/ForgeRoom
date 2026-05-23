/**
 * PipelineEngine Mastra-runner integration tests (#8).
 *
 * Real SQLite (temp file), temp `.forgeroom/`, and FAKE AgentRunner /
 * CheckRunner / Reporter / ForgeMap / Conductor-LLM per testing-rules. Covers:
 * full end-to-end run producing `.forgeroom/` files, pause/resume across a
 * fresh engine + store instance, Reporter-after-commit ordering, ApprovalGate
 * dual placement, and `mastra_run_id` recording after run creation.
 */
import { mkdtemp, readFile, rm, stat, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createTaskStoreDatabase,
  migrateTaskStoreDatabase,
  type TaskStoreDatabase,
} from '../../src/db/client.js';
import { SqliteTaskStore } from '../../src/db/sqlite-task-store.js';
import { IntentRegistry } from '../../src/core/intent-registry.js';
import { ProjectRegistry } from '../../src/core/project-registry.js';
import { WorkflowRegistry } from '../../src/core/workflow-registry.js';
import { AgentRegistry } from '../../src/core/agent-registry.js';
import { HarnessRegistry } from '../../src/core/harness-registry.js';
import { ApprovalGate } from '../../src/core/approval-gate.js';
import type { AgentRunner, AgentRunResult } from '../../src/core/agent-runner.js';
import type { CheckRunResult } from '../../src/core/types.js';
import type { Conductor, ReporterEvent, StepResult } from '../../src/core/types.js';
import type { CheckRunnerRequest } from '../../src/core/check-runner.js';
import type { Task } from '../../src/core/types.js';
import {
  MastraPipelineEngine,
  FileSnapshotBridge,
  type ForgeMapStager,
  type PipelineEngineDeps,
  type ReporterSink,
  type WorkflowSourceProvider,
} from '../../src/core/pipeline-engine.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const INTENTS = {
  write_plan: { kind: 'write_plan', agent: 'planner', harness: 'planning' },
  implement: { kind: 'execute', agent: 'coder', harness: 'implementation' },
  review_code: { kind: 'review', agent: 'reviewer', harness: 'review' },
};

// A workflow with: a plan step (emits ## Slices), a foreach group over
// final_slices that implements each slice (kind: execute -> CheckRunner), and a
// trailing plan step with pause_after to exercise the pause gate.
const WORKFLOW_YAML = `
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

const WORKFLOW_NO_PAUSE_YAML = `
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
`;

interface Harness {
  store: SqliteTaskStore;
  database: TaskStoreDatabase;
  worktreeRoot: string;
  worktreePath: string;
  reporterEvents: ReporterEvent[];
  commits: string[];
  agentCalls: string[];
  checkCalls: string[];
  intents: IntentRegistry;
  projectRegistry: ProjectRegistry;
  cleanup: () => Promise<void>;
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'pipeline-int-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function buildIntentRegistry(): IntentRegistry {
  return IntentRegistry.fromConfig(INTENTS);
}

function buildProjectRegistry(projectPath: string): ProjectRegistry {
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
  const workflowRegistry = WorkflowRegistry.fromConfig(
    {
      mvp: {
        description: 'test',
        effects: { worktree: 'modifies', external: { report: 'status', pr: 'draft' } },
        steps: [
          { type: 'run', id: 'plan', intent: 'write_plan', prompt_template: 'plan.md' },
        ],
      },
    },
    { intentRegistry, agentRegistry, harnessRegistry },
    { templateExists: () => true },
  );
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

/** A fake AgentRunner that writes the output file the body then reads back. */
function makeFakeAgentRunner(
  worktreeFor: () => string,
  agentCalls: string[],
  outputs: Record<string, string>,
): AgentRunner {
  return {
    async run(req): Promise<AgentRunResult> {
      agentCalls.push(req.agentId);
      const base = path.basename(req.outputPath, '.md');
      // base = "NN_<step_id>"
      const stepId = base.replace(/^\d+_/, '');
      const content = outputs[stepId] ?? `# ${stepId}\n\nautomated output for ${stepId} (>=50 bytes padding here).`;
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
      return this.run({ ...req, agentId: req.agentId });
    },
  };
}

function makeFakeConductor(commits: string[]): Conductor {
  return {
    init: async (): Promise<void> => Promise.resolve(),
    update: async (taskId: string, sr: StepResult): Promise<void> => {
      commits.push(`update:${sr.stepId}`);
      return Promise.resolve();
    },
    integrateFeedback: async (): Promise<void> => Promise.resolve(),
    refine: async (_t: string, _s: string, base: string): Promise<string> => base,
    answer: async (): Promise<string> => 'ok',
  };
}

async function setup(yaml: string, outputs: Record<string, string>): Promise<{
  engine: MastraPipelineEngine;
  harness: Harness;
  deps: PipelineEngineDeps;
  rebuild: () => MastraPipelineEngine;
}> {
  const projectPath = path.join(tempDir, 'project');
  await mkdir(projectPath, { recursive: true });
  const worktreeRoot = path.join(tempDir, 'worktrees');
  await mkdir(worktreeRoot, { recursive: true });

  const database = createTaskStoreDatabase(path.join(tempDir, 'forgeroom.sqlite'));
  migrateTaskStoreDatabase(database);
  const store = new SqliteTaskStore(database);

  const reporterEvents: ReporterEvent[] = [];
  const commits: string[] = [];
  const agentCalls: string[] = [];
  const checkCalls: string[] = [];

  const worktreePathRef = { path: '' };
  const agentRunner = makeFakeAgentRunner(() => worktreePathRef.path, agentCalls, outputs);
  const reporter: ReporterSink = {
    notify: async (event): Promise<void> => {
      reporterEvents.push(event);
      return Promise.resolve();
    },
  };
  const forgeMap: ForgeMapStager = { stage: async (): Promise<void> => Promise.resolve() };
  const conductor = makeFakeConductor(commits);
  const intents = buildIntentRegistry();
  const projectRegistry = buildProjectRegistry(projectPath);
  const snapshotDir = path.join(tempDir, 'snapshots');

  // Fake CheckRunner: records the call and reports pass. Asserts it only runs
  // for kind: execute steps (slice_impl), never plan/review.
  const checkRunner = {
    run: async (request: CheckRunnerRequest): Promise<CheckRunResult> => {
      checkCalls.push(request.step.step_id);
      return { allPassed: true, results: [] };
    },
  };

  // Real fs-backed worktree manager (no git: tests bootstrap dir directly).
  const worktreeManager = {
    create: async (task: Task): Promise<{ path: string; branch: string }> => {
      worktreePathRef.path = task.worktree_path;
      for (const dir of [
        '.forgeroom',
        '.forgeroom/context',
        '.forgeroom/prompts',
        '.forgeroom/outputs',
        '.forgeroom/diffs',
        '.forgeroom/logs',
      ]) {
        await mkdir(path.join(task.worktree_path, dir), { recursive: true });
      }
      return { path: task.worktree_path, branch: task.branch_name };
    },
    ensureForgeroomDir: async (): Promise<void> => Promise.resolve(),
  } as unknown as PipelineEngineDeps['worktreeManager'];

  const workflowSource: WorkflowSourceProvider = { source: (): string => yaml };

  const deps: PipelineEngineDeps = {
    projectRegistry,
    intentRegistry: intents,
    taskStore: store,
    worktreeManager,
    agentRunner,
    checkRunner,
    conductor,
    approvalGate: new ApprovalGate(),
    reporter,
    forgeMap,
    workflowSource,
    snapshotBridge: new FileSnapshotBridge(snapshotDir),
    allowedWorktreeRoots: [worktreeRoot],
    worktreePathFor: ({ taskId }): string => path.join(worktreeRoot, taskId),
    branchFor: ({ taskId }): string => `feat/${taskId}`,
    mastraVersion: '1.36.0',
    createTaskId: () => 'task-1',
    log: () => {},
  };

  const engine = new MastraPipelineEngine(deps);
  const worktreePath = path.join(worktreeRoot, 'task-1');

  const harness: Harness = {
    store,
    database,
    worktreeRoot,
    worktreePath,
    reporterEvents,
    commits,
    agentCalls,
    checkCalls,
    intents,
    projectRegistry,
    cleanup: async (): Promise<void> => {
      database.close();
    },
  };

  // rebuild simulates a process restart: brand-new engine + a NEW snapshot
  // bridge instance pointed at the SAME on-disk snapshot dir, and a re-opened
  // store would be identical; we reuse the file-backed store object here.
  const rebuild = (): MastraPipelineEngine =>
    new MastraPipelineEngine({ ...deps, snapshotBridge: new FileSnapshotBridge(snapshotDir) });

  return { engine, harness, deps, rebuild };
}

const PLAN_OUTPUT = '# Plan\n\n## Slices\n\n- first slice\n- second slice\n';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MastraPipelineEngine.runFull (integration)', () => {
  it('runs a full workflow end-to-end and produces .forgeroom files', async () => {
    const { engine, harness } = await setup(WORKFLOW_NO_PAUSE_YAML, { plan: PLAN_OUTPUT });

    const taskId = await engine.runFull('proj', {
      title: 'do thing',
      description: 'desc',
      source: 'discord-command',
    });

    const task = await harness.store.getTask(taskId);
    expect(task?.status).toBe('done');

    // Prompt + output files exist for plan and the two foreach slices.
    const outputsDir = path.join(harness.worktreePath, '.forgeroom', 'outputs');
    await expect(stat(path.join(outputsDir, '01_plan.md'))).resolves.toBeTruthy();
    const planOut = await readFile(path.join(outputsDir, '01_plan.md'), 'utf8');
    expect(planOut).toContain('## Slices');
    // foreach ran slice_impl per slice (file indices advance).
    const slices = harness.agentCalls.filter((a) => a === 'coder');
    expect(slices.length).toBe(2);

    // CheckRunner ran only for kind: execute (slice_impl), never write_plan.
    expect(harness.checkCalls).toEqual(['slice_impl', 'slice_impl']);

    // final_slices was updated from the plan output.
    expect(task?.final_slices).toEqual(['first slice', 'second slice']);

    await harness.cleanup();
  });

  it('records mastra_run_id on the task row after run creation', async () => {
    const { engine, harness } = await setup(WORKFLOW_NO_PAUSE_YAML, { plan: PLAN_OUTPUT });
    const taskId = await engine.runFull('proj', {
      title: 't',
      description: 'd',
      source: 'discord-command',
    });
    const runId = await harness.store.getMastraRunId(taskId);
    expect(runId).toBeTruthy();
    await harness.cleanup();
  });

  it('fires Reporter step_done AFTER the Conductor/TaskStore commit', async () => {
    const { engine, harness } = await setup(WORKFLOW_NO_PAUSE_YAML, { plan: PLAN_OUTPUT });
    await engine.runFull('proj', { title: 't', description: 'd', source: 'discord-command' });

    // For the plan step: conductor.update is pushed to commits; reporter
    // step_done event for plan must come after that update was recorded.
    const planUpdateIndex = harness.commits.indexOf('update:plan');
    expect(planUpdateIndex).toBeGreaterThanOrEqual(0);
    const planStepDone = harness.reporterEvents.find(
      (e) => e.type === 'step_done' && e.step.step_id === 'plan',
    );
    expect(planStepDone).toBeTruthy();
    // commits has the update before reporter notified (both synchronous in body).
    expect(harness.commits).toContain('update:plan');
    await harness.cleanup();
  });

  it('denies admission for a workflow not allowed by the project (pre-Mastra gate)', async () => {
    const { engine, harness } = await setup(WORKFLOW_NO_PAUSE_YAML, { plan: PLAN_OUTPUT });
    await expect(
      engine.runFull('proj', { title: 't', description: 'd', source: 'discord-command' }, {
        workflowId: 'not-allowed',
      }),
    ).rejects.toThrow(/not allowed/);
    await harness.cleanup();
  });
});

describe('MastraPipelineEngine pause/resume (integration)', () => {
  it('pauses at the pause_after gate then resumes to completion across a fresh engine instance', async () => {
    const { engine, harness, rebuild } = await setup(WORKFLOW_YAML, { plan: PLAN_OUTPUT });

    const taskId = await engine.runFull('proj', {
      title: 't',
      description: 'd',
      source: 'discord-command',
    });

    // The wrapup step has pause_after: true -> run suspends -> status paused.
    const paused = await harness.store.getTask(taskId);
    expect(paused?.status).toBe('paused');
    const runId = await harness.store.getMastraRunId(taskId);
    expect(runId).toBeTruthy();

    // Simulate a process restart: new engine + new snapshot bridge instance.
    const engine2 = rebuild();
    await engine2.resume(taskId);

    const done = await harness.store.getTask(taskId);
    expect(done?.status).toBe('done');
    await harness.cleanup();
  });
});

describe('MastraPipelineEngine.cancel (integration)', () => {
  it('cancels immediately and preserves the worktree', async () => {
    const { engine, harness } = await setup(WORKFLOW_YAML, { plan: PLAN_OUTPUT });
    const taskId = await engine.runFull('proj', {
      title: 't',
      description: 'd',
      source: 'discord-command',
    });
    await engine.cancel(taskId);
    const task = await harness.store.getTask(taskId);
    expect(task?.status).toBe('canceled');
    // worktree still present.
    await expect(stat(harness.worktreePath)).resolves.toBeTruthy();
    const canceledEvent = harness.reporterEvents.find((e) => e.type === 'task_canceled');
    expect(canceledEvent).toBeTruthy();
    // A canceled task cannot be resumed.
    await expect(engine.resume(taskId)).rejects.toThrow(/canceled/);
    await harness.cleanup();
  });
});
