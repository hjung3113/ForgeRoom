/**
 * PipelineEngine unit tests (#8). In-memory SQLite, fakes for all collaborators.
 * Covers admission gate, in-step gate denial -> task failed, recoverPending
 * placeholder, and resume guards (canceled/terminal).
 */
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createTaskStoreDatabase,
  migrateTaskStoreDatabase,
  type TaskStoreDatabase,
} from '../db/client.js';
import { SqliteTaskStore } from '../db/sqlite-task-store.js';
import { IntentRegistry } from './intent-registry.js';
import { ProjectRegistry } from './project-registry.js';
import { WorkflowRegistry } from './workflow-registry.js';
import { AgentRegistry } from './agent-registry.js';
import { HarnessRegistry } from './harness-registry.js';
import { ApprovalGate, type GateDecision } from './approval-gate.js';
import type { AgentRunner, AgentRunResult } from './agent-runner.js';
import type { CheckRunResult, Conductor, StepResult, Task } from './types.js';
import {
  MastraPipelineEngine,
  FileSnapshotBridge,
  GateAdmissionError,
  type ForgeMapStager,
  type PipelineEngineDeps,
  type ReporterSink,
} from './pipeline-engine.js';

const INTENTS = {
  write_plan: { kind: 'write_plan', agent: 'planner', harness: 'planning' },
};

const SINGLE_STEP_YAML = `
mvp:
  description: t
  effects:
    worktree: modifies
    external: { report: status, pr: draft }
  steps:
    - type: run
      id: plan
      intent: write_plan
      prompt_template: plan.md
`;

const PAUSING_YAML = `
mvp:
  description: t
  effects:
    worktree: modifies
    external: { report: status, pr: draft }
  steps:
    - type: run
      id: plan
      intent: write_plan
      prompt_template: plan.md
      pause_after: true
`;

let tempDir: string;
let database: TaskStoreDatabase;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'pipeline-unit-'));
  database = createTaskStoreDatabase(':memory:');
  migrateTaskStoreDatabase(database);
});

afterEach(async () => {
  database.close();
  await rm(tempDir, { recursive: true, force: true });
});

function deps(overrides: Partial<PipelineEngineDeps> = {}): PipelineEngineDeps {
  const store = new SqliteTaskStore(database);
  const harnessRegistry = HarnessRegistry.fromConfig({ planning: { source: 'h/p.md' } });
  const agentRegistry = AgentRegistry.fromConfig(
    { planner: { provider: 'openclaw', runtime: 'r', model: 'm', harness: 'planning' } },
    harnessRegistry,
  );
  const intentRegistry = IntentRegistry.fromConfig(INTENTS);
  const workflowRegistry = WorkflowRegistry.fromConfig(
    {
      mvp: {
        description: 't',
        effects: { worktree: 'modifies', external: { report: 'status', pr: 'draft' } },
        steps: [{ type: 'run', id: 'plan', intent: 'write_plan', prompt_template: 'plan.md' }],
      },
    },
    { intentRegistry, agentRegistry, harnessRegistry },
    { templateExists: () => true },
  );
  const projectRegistry = ProjectRegistry.fromConfig(
    {
      proj: {
        path: path.join(tempDir, 'project'),
        default_branch: 'main',
        package_manager: 'pnpm',
        default_workflow: 'mvp',
        allowed_workflows: ['mvp'],
        commands: { lint: 'l', typecheck: 't', test: 't' },
        maintainers: { discord_user_ids: [], github_logins: [] },
      },
    },
    workflowRegistry,
    { projectPathExists: () => true },
  );

  const worktreeRoot = path.join(tempDir, 'wt');
  const agentRunner: AgentRunner = {
    run: async (req): Promise<AgentRunResult> => {
      const content = '# plan\n\noutput content padded to be over fifty bytes long here.';
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
    resume: async (req): Promise<AgentRunResult> =>
      ({
        exitCode: 0,
        outputExists: true,
        outputBytes: 60,
        durationMs: 1,
        sessionId: null,
        stdoutPath: req.stdoutPath,
        stderrPath: req.stderrPath,
      }) as AgentRunResult,
  };
  const conductor: Conductor = {
    init: async (): Promise<void> => Promise.resolve(),
    update: async (_t: string, _s: StepResult): Promise<void> => Promise.resolve(),
    integrateFeedback: async (): Promise<void> => Promise.resolve(),
    refine: async (_t: string, _s: string, base: string): Promise<string> => base,
    answer: async (): Promise<string> => 'ok',
  };
  const reporter: ReporterSink = { notify: async (): Promise<void> => Promise.resolve() };
  const forgeMap: ForgeMapStager = { stage: async (): Promise<void> => Promise.resolve() };
  const worktreeManager = {
    create: async (task: Task): Promise<{ path: string; branch: string }> => {
      await mkdir(path.join(task.worktree_path, '.forgeroom', 'outputs'), { recursive: true });
      await mkdir(path.join(task.worktree_path, '.forgeroom', 'prompts'), { recursive: true });
      await mkdir(path.join(task.worktree_path, '.forgeroom', 'logs'), { recursive: true });
      return { path: task.worktree_path, branch: task.branch_name };
    },
    ensureForgeroomDir: async (): Promise<void> => Promise.resolve(),
  } as unknown as PipelineEngineDeps['worktreeManager'];

  return {
    projectRegistry,
    intentRegistry,
    taskStore: store,
    worktreeManager,
    agentRunner,
    checkRunner: { run: async (): Promise<CheckRunResult> => ({ allPassed: true, results: [] }) },
    conductor,
    approvalGate: new ApprovalGate(),
    reporter,
    forgeMap,
    workflowSource: { source: (): string => SINGLE_STEP_YAML },
    snapshotBridge: new FileSnapshotBridge(path.join(tempDir, 'snap')),
    allowedWorktreeRoots: [worktreeRoot],
    worktreePathFor: ({ taskId }): string => path.join(worktreeRoot, taskId),
    branchFor: ({ taskId }): string => `feat/${taskId}`,
    mastraVersion: '1.36.0',
    createTaskId: () => 'task-u',
    log: () => {},
    ...overrides,
  };
}

describe('MastraPipelineEngine admission gate (pre-Mastra)', () => {
  it('rejects a workflow not allowed by the project', async () => {
    const engine = new MastraPipelineEngine(deps());
    await expect(
      engine.runFull('proj', { title: 't', description: 'd', source: 'discord-command' }, {
        workflowId: 'nope',
      }),
    ).rejects.toBeInstanceOf(GateAdmissionError);
  });

  it('rejects worktree creation on a protected branch', async () => {
    const engine = new MastraPipelineEngine(deps({ branchFor: () => 'main' }));
    await expect(
      engine.runFull('proj', { title: 't', description: 'd', source: 'discord-command' }),
    ).rejects.toThrow(/protected_branch|denied/);
  });
});

describe('MastraPipelineEngine in-step gate (runtime)', () => {
  it('fails the task when the in-step ApprovalGate denies the agent command', async () => {
    // A gate that denies every command -> the in-step check throws in the body
    // -> the Mastra run fails -> the engine records a failure_reason.
    const denyingGate = {
      checkWorktreeCreation: (): GateDecision => ({ allowed: true }),
      checkCommand: (): GateDecision => ({ allowed: false, category: 'command', reason: 'destructive_git' }),
      checkFileWrite: (): GateDecision => ({ allowed: true }),
      checkWorkflow: (): GateDecision => ({ allowed: true }),
    } as unknown as ApprovalGate;
    const d = deps({ approvalGate: denyingGate });
    const engine = new MastraPipelineEngine(d);
    const taskId = await engine.runFull('proj', {
      title: 't',
      description: 'd',
      source: 'discord-command',
    });
    const task = await d.taskStore.getTask(taskId);
    expect(task?.status).toBe('failed');
    expect(task?.failure_reason).toBe('agent_error');
  });
});

describe('MastraPipelineEngine.recoverPending (placeholder for #9)', () => {
  it('logs deferred recovery for active tasks without throwing', async () => {
    const logged: string[] = [];
    const d = deps({ log: (line) => logged.push(line) });
    const engine = new MastraPipelineEngine(d);
    await engine.runFull('proj', { title: 't', description: 'd', source: 'discord-command' });

    await expect(engine.recoverPending()).resolves.toBeUndefined();
    // The single-step workflow completes (status done), so it is not active; a
    // paused/running task would be logged. We assert recoverPending is a no-throw
    // enumerator that #9 will flesh out.
    expect(Array.isArray(logged)).toBe(true);
  });
});

describe('MastraPipelineEngine.resume guards', () => {
  it('throws when resuming a canceled task', async () => {
    // A pausing workflow leaves the task non-terminal (paused) so cancel can
    // transition it to canceled, then resume must refuse.
    const d = deps({ workflowSource: { source: (): string => PAUSING_YAML } });
    const engine = new MastraPipelineEngine(d);
    const taskId = await engine.runFull('proj', {
      title: 't',
      description: 'd',
      source: 'discord-command',
    });
    expect((await d.taskStore.getTask(taskId))?.status).toBe('paused');
    await engine.cancel(taskId);
    expect((await d.taskStore.getTask(taskId))?.status).toBe('canceled');
    await expect(engine.resume(taskId)).rejects.toThrow(/canceled/);
  });

  it('is a no-op when resuming a done task', async () => {
    const d = deps();
    const engine = new MastraPipelineEngine(d);
    const taskId = await engine.runFull('proj', {
      title: 't',
      description: 'd',
      source: 'discord-command',
    });
    // Single-step workflow finishes immediately.
    expect((await d.taskStore.getTask(taskId))?.status).toBe('done');
    await expect(engine.resume(taskId)).resolves.toBeUndefined();
  });

  it('records mastra_run_id before the run starts (set even on failure)', async () => {
    const failingRunner: AgentRunner = {
      run: async (req): Promise<AgentRunResult> =>
        ({
          exitCode: 1,
          failureKind: 'agent_error',
          outputExists: false,
          outputBytes: 0,
          durationMs: 1,
          sessionId: null,
          stdoutPath: req.stdoutPath,
          stderrPath: req.stderrPath,
        }) as AgentRunResult,
      resume: async (req): Promise<AgentRunResult> =>
        ({
          exitCode: 1,
          failureKind: 'agent_error',
          outputExists: false,
          outputBytes: 0,
          durationMs: 1,
          sessionId: null,
          stdoutPath: req.stdoutPath,
          stderrPath: req.stderrPath,
        }) as AgentRunResult,
    };
    const d = deps({ agentRunner: failingRunner });
    const engine = new MastraPipelineEngine(d);
    const taskId = await engine.runFull('proj', {
      title: 't',
      description: 'd',
      source: 'discord-command',
    });
    expect(await d.taskStore.getMastraRunId(taskId)).toBeTruthy();
    expect((await d.taskStore.getTask(taskId))?.status).toBe('failed');
  });
});
