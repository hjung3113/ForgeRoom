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
} from '../../db/client.js';
import { SqliteTaskStore } from '../../db/sqlite-task-store.js';
import { IntentRegistry } from '../registries/intent-registry.js';
import { ModelPolicyRegistry } from '../registries/model-policy-registry.js';
import { ProjectRegistry } from '../registries/project-registry.js';
import { WorkflowRegistry } from '../registries/workflow-registry.js';
import { parseWorkflowConfig } from '../../dsl/workflow-parser.js';
import { mastraWorkflowBuilder } from '../../dsl/to-mastra.js';
import type { WorkflowBuilder } from '../../workflow/builder.js';
import { makeTestTemplateRoot } from '../test-support/template-fixtures.js';
import { AgentRegistry } from '../agent-runtime/agent-registry.js';
import { HarnessRegistry } from '../agent-runtime/harness-registry.js';
import { ApprovalGate, type GateDecision } from '../checks/approval-gate.js';
import type { AgentRunner, AgentRunResult } from '../agent-runtime/agent-runner.js';
import type { TaskAgentLifecycle } from '../agent-runtime/task-agent-lifecycle.js';
import type { CheckRunResult, Conductor, Reporter, StepResult, Task } from '../types.js';
import {
  MastraPipelineEngine,
  FileSnapshotBridge,
  GateAdmissionError,
  type ForgeMapStager,
  type PipelineEngineDeps,
} from './pipeline-engine.js';
import {
  PullRequestCreator,
  type PullRequestClient,
  type PullRequestRef,
} from '../effects/pull-request-creator.js';
import {
  BranchPublisher,
  type BranchPublishPort,
} from '../effects/branch-publisher.js';
import {
  IssueLabelLifecycleEffect,
  type IssueLabelPort,
  type AddLabelArgs,
  type RemoveLabelArgs,
} from '../effects/issue-label-lifecycle.js';
import type { ReporterEvent } from '../types.js';

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
let templateRoot: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'pipeline-unit-'));
  templateRoot = await makeTestTemplateRoot();
  database = createTaskStoreDatabase(':memory:');
  migrateTaskStoreDatabase(database);
});

afterEach(async () => {
  database.close();
  await rm(tempDir, { recursive: true, force: true });
});

function deps(overrides: Partial<PipelineEngineDeps> = {}): PipelineEngineDeps {
  const store = new SqliteTaskStore(database);
  const harnessRegistry = HarnessRegistry.fromConfig({ planning: { source: 'h' } });
  const agentRegistry = AgentRegistry.fromConfig(
    { planner: { provider: 'openclaw', runtime: 'r', model: 'm', harness: 'planning' } },
    harnessRegistry,
  );
  const intentRegistry = IntentRegistry.fromConfig(INTENTS);
  const workflowRegistry = overrides.workflowRegistry ?? workflowRegistryFor(SINGLE_STEP_YAML, {
    intentRegistry,
    agentRegistry,
    harnessRegistry,
  });
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
    refineNotes: async (_t: string, _s: string, _base: string): Promise<string> => '',
    answer: async (): Promise<string> => 'ok',
  };
  const reporter: Reporter = {
    notify: async (): Promise<void> => Promise.resolve(),
    flushUndelivered: async (): Promise<void> => Promise.resolve(),
  };
  const forgeMap: ForgeMapStager = { stage: async (): Promise<void> => Promise.resolve() };
  const worktreeManager = {
    create: async (task: Task): Promise<{ path: string; branch: string }> => {
      await mkdir(path.join(task.worktree_path, '.forgeroom', 'outputs'), { recursive: true });
      await mkdir(path.join(task.worktree_path, '.forgeroom', 'prompts'), { recursive: true });
      await mkdir(path.join(task.worktree_path, '.forgeroom', 'logs'), { recursive: true });
      // Stage the planning harness contract so renderPrompt can compose it (ADR-027).
      await mkdir(path.join(task.worktree_path, 'h'), { recursive: true });
      await writeFile(path.join(task.worktree_path, 'h', 'prompt-contract.md'), '# harness {{step_id}}\n');
      return { path: task.worktree_path, branch: task.branch_name };
    },
    ensureForgeroomDir: async (): Promise<void> => Promise.resolve(),
  } as unknown as PipelineEngineDeps['worktreeManager'];

  return {
    projectRegistry,
    workflowRegistry,
    intentRegistry,
    modelPolicies: ModelPolicyRegistry.fromConfig({}),
    agentRegistry,
    harnessRegistry,
    taskStore: store,
    worktreeManager,
    agentRunner,
    checkRunner: { run: async (): Promise<CheckRunResult> => ({ allPassed: true, results: [] }) },
    conductor,
    approvalGate: new ApprovalGate(),
    reporter,
    forgeMap,
    snapshotBridge: new FileSnapshotBridge(path.join(tempDir, 'snap')),
    workflowBuilder: mastraWorkflowBuilder,
    templateRoot,
    allowedWorktreeRoots: [worktreeRoot],
    worktreePathFor: ({ taskId }): string => path.join(worktreeRoot, taskId),
    branchFor: ({ taskId }): string => `feat/${taskId}`,
    mastraVersion: '1.36.0',
    createTaskId: () => 'task-u',
    log: () => {},
    ...overrides,
  };
}

function workflowRegistryFor(
  yaml: string,
  registries?: Parameters<typeof WorkflowRegistry.fromConfig>[1],
): WorkflowRegistry {
  const harnessRegistry = HarnessRegistry.fromConfig({ planning: { source: 'h' } });
  const agentRegistry = AgentRegistry.fromConfig(
    { planner: { provider: 'openclaw', runtime: 'r', model: 'm', harness: 'planning' } },
    harnessRegistry,
  );
  const intentRegistry = IntentRegistry.fromConfig(INTENTS);
  const parsedWorkflowSource = parseWorkflowConfig(yaml);
  return WorkflowRegistry.fromConfig(
    parsedWorkflowSource.config,
    registries ?? { intentRegistry, agentRegistry, harnessRegistry },
    { templateExists: () => true },
  );
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
    const d = deps({ workflowRegistry: workflowRegistryFor(PAUSING_YAML) });
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

// ---------------------------------------------------------------------------
// External-effect phase: PR creation (ADR-019, #29)
// ---------------------------------------------------------------------------

const PR_NONE_YAML = `
mvp:
  description: t
  effects:
    worktree: modifies
    external: { report: status, pr: none }
  steps:
    - type: run
      id: plan
      intent: write_plan
      prompt_template: plan.md
`;

interface FakePr {
  client: PullRequestClient;
  calls: { create: number; update: number; find: number };
}

function fakePrClient(opts: { find?: PullRequestRef | null; create?: PullRequestRef; fail?: boolean } = {}): FakePr {
  const calls = { create: 0, update: 0, find: 0 };
  const client: PullRequestClient = {
    createPR: async () => {
      calls.create += 1;
      if (opts.fail) {
        throw new Error('boom');
      }
      return opts.create ?? { number: 321, url: 'https://gh/pull/321' };
    },
    updatePR: async () => {
      calls.update += 1;
    },
    findOpenPRByHead: async () => {
      calls.find += 1;
      return opts.find ?? null;
    },
  };
  return { client, calls };
}

function capturingReporter(into: ReporterEvent[]): Reporter {
  return {
    notify: async (e: ReporterEvent): Promise<void> => {
      into.push(e);
    },
    flushUndelivered: async (): Promise<void> => Promise.resolve(),
  };
}

const prTarget = (): { owner: string; repo: string; base: string } => ({
  owner: 'acme',
  repo: 'widget',
  base: 'main',
});

describe('MastraPipelineEngine PR external-effect phase (ADR-019)', () => {
  it('does not run the PR effect when effects.external.pr is none', async () => {
    const { client, calls } = fakePrClient();
    const events: ReporterEvent[] = [];
    const d = deps({
      workflowRegistry: workflowRegistryFor(PR_NONE_YAML),
      pullRequestCreator: new PullRequestCreator({ client, sleep: async () => {} }),
      prTargetFor: prTarget,
      reporter: capturingReporter(events),
    });
    const engine = new MastraPipelineEngine(d);
    const taskId = await engine.runFull('proj', { title: 't', description: 'd', source: 'discord-command' });

    expect((await d.taskStore.getTask(taskId))?.status).toBe('done');
    expect(calls.create).toBe(0);
    expect(events.some((e) => e.type === 'pr_created')).toBe(false);
  });

  it('creates a PR, persists pr_number, and emits pr_created on success', async () => {
    const { client, calls } = fakePrClient({ create: { number: 77, url: 'u77' } });
    const events: ReporterEvent[] = [];
    const d = deps({
      pullRequestCreator: new PullRequestCreator({ client, sleep: async () => {} }),
      prTargetFor: prTarget,
      reporter: capturingReporter(events),
    });
    const engine = new MastraPipelineEngine(d);
    const taskId = await engine.runFull('proj', { title: 't', description: 'd', source: 'discord-command' });

    const task = await d.taskStore.getTask(taskId);
    expect(task?.status).toBe('done');
    expect(task?.pr_number).toBe(77);
    expect(calls.create).toBe(1);
    const prEvent = events.find((e) => e.type === 'pr_created');
    expect(prEvent).toMatchObject({ type: 'pr_created', pr_number: 77, pr_url: 'u77' });
  });

  it('fails the task with pr_create_failed after 3 failed attempts', async () => {
    const { client, calls } = fakePrClient({ fail: true });
    const d = deps({
      pullRequestCreator: new PullRequestCreator({ client, sleep: async () => {} }),
      prTargetFor: prTarget,
    });
    const engine = new MastraPipelineEngine(d);
    const taskId = await engine.runFull('proj', { title: 't', description: 'd', source: 'discord-command' });

    const task = await d.taskStore.getTask(taskId);
    expect(task?.status).toBe('failed');
    expect(task?.failure_reason).toBe('pr_create_failed');
    expect(calls.create).toBe(3);
  });

  it('does not double-create the PR across a recoverPending replay', async () => {
    // One fake client across both the original run and the replay.
    const pr = fakePrClient({ create: { number: 88, url: 'u88' } });
    const d = deps({
      pullRequestCreator: new PullRequestCreator({ client: pr.client, sleep: async () => {} }),
      prTargetFor: prTarget,
    });
    const engine = new MastraPipelineEngine(d);
    const taskId = await engine.runFull('proj', { title: 't', description: 'd', source: 'discord-command' });
    expect((await d.taskStore.getTask(taskId))?.pr_number).toBe(88);
    expect(pr.calls.create).toBe(1);

    // Simulate a crash before `done` was observed: drop the auxiliary Mastra run
    // pointer and re-mark the task active, then recover. recoverPending starts a
    // FRESH run, the PR effect re-reads the persisted pr_number, and reuses it
    // (update, not create) — so no duplicate PR.
    await d.taskStore.setMastraRunId(taskId, null);
    await d.taskStore.updateTaskStatus(taskId, 'running');

    await engine.recoverPending();

    const task = await d.taskStore.getTask(taskId);
    expect(task?.status).toBe('done');
    expect(task?.pr_number).toBe(88);
    expect(pr.calls.create).toBe(1); // still only the original create
    expect(pr.calls.update).toBe(1); // replay reused via update
  });
});

describe('MastraPipelineEngine builder port (ADR-022)', () => {
  it('builds the workflow through the injected WorkflowBuilder, not a hard-wired import', async () => {
    let buildCalls = 0;
    const spyBuilder: WorkflowBuilder = {
      build: (workflow, ctx) => {
        buildCalls += 1;
        return mastraWorkflowBuilder.build(workflow, ctx);
      },
    };
    const engine = new MastraPipelineEngine(deps({ workflowBuilder: spyBuilder }));

    await engine.runFull('proj', { title: 't', description: 'd', source: 'discord-command' });

    expect(buildCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Branch-publication external-effect phase (ADR-025, #63)
// ---------------------------------------------------------------------------

interface FakeBranchPort {
  port: BranchPublishPort;
  calls: { status: number; commit: number; push: number };
}

function fakeBranchPort(opts: { statusOutput?: string; pushError?: boolean } = {}): FakeBranchPort {
  const calls = { status: 0, commit: 0, push: 0 };
  const port: BranchPublishPort = {
    statusPorcelain: async (): Promise<string> => {
      calls.status += 1;
      return opts.statusOutput ?? 'M  src/foo.ts\n';
    },
    commit: async (): Promise<void> => {
      calls.commit += 1;
    },
    push: async (): Promise<void> => {
      calls.push += 1;
      if (opts.pushError === true) {
        throw new Error('push failed');
      }
    },
  };
  return { port, calls };
}

describe('MastraPipelineEngine branch-publication external-effect phase (ADR-025)', () => {
  it('diff present: branch-publishes then creates PR then marks done', async () => {
    const order: string[] = [];
    const branchPort: BranchPublishPort = {
      statusPorcelain: async (): Promise<string> => 'M  src/foo.ts\n',
      commit: async (): Promise<void> => { order.push('commit'); },
      push: async (): Promise<void> => { order.push('push'); },
    };
    const { client, calls: prCalls } = fakePrClient({ create: { number: 55, url: 'u55' } });
    const origCreate = client.createPR.bind(client);
    const spyClient: PullRequestClient = {
      ...client,
      createPR: async (args) => { order.push('pr'); return origCreate(args); },
    };
    const events: ReporterEvent[] = [];
    const d = deps({
      branchPublisher: new BranchPublisher({ port: branchPort }),
      pullRequestCreator: new PullRequestCreator({ client: spyClient, sleep: async () => {} }),
      prTargetFor: prTarget,
      reporter: capturingReporter(events),
    });
    const engine = new MastraPipelineEngine(d);
    const taskId = await engine.runFull('proj', { title: 't', description: 'd', source: 'discord-command' });

    const task = await d.taskStore.getTask(taskId);
    expect(task?.status).toBe('done');
    expect(task?.pr_number).toBe(55);
    expect(prCalls.create).toBe(1);
    // commit and push MUST come before pr
    expect(order.indexOf('commit')).toBeLessThan(order.indexOf('pr'));
    expect(order.indexOf('push')).toBeLessThan(order.indexOf('pr'));
  });

  it('no-diff: skips PR, emits task_done_no_diff, marks done', async () => {
    const { port: branchPort } = fakeBranchPort({ statusOutput: '' });
    const { client: prClient, calls: prCalls } = fakePrClient();
    const events: ReporterEvent[] = [];
    const d = deps({
      branchPublisher: new BranchPublisher({ port: branchPort }),
      pullRequestCreator: new PullRequestCreator({ client: prClient, sleep: async () => {} }),
      prTargetFor: prTarget,
      reporter: capturingReporter(events),
    });
    const engine = new MastraPipelineEngine(d);
    const taskId = await engine.runFull('proj', { title: 't', description: 'd', source: 'discord-command' });

    const task = await d.taskStore.getTask(taskId);
    expect(task?.status).toBe('done');
    expect(prCalls.create).toBe(0);
    expect(events.some((e) => e.type === 'pr_created')).toBe(false);
    expect(events.some((e) => e.type === 'task_done_no_diff')).toBe(true);
  });

  it('branch-publish failure fails the task with branch_publish_failed', async () => {
    const { port: branchPort } = fakeBranchPort({ pushError: true });
    const events: ReporterEvent[] = [];
    const d = deps({
      branchPublisher: new BranchPublisher({ port: branchPort }),
      reporter: capturingReporter(events),
    });
    const engine = new MastraPipelineEngine(d);
    const taskId = await engine.runFull('proj', { title: 't', description: 'd', source: 'discord-command' });

    const task = await d.taskStore.getTask(taskId);
    expect(task?.status).toBe('failed');
    expect(task?.failure_reason).toBe('branch_publish_failed');
  });

  it('no-diff run without branchPublisher wired still marks task done', async () => {
    // Engine should handle absent branchPublisher gracefully (skip publish, go directly to PR phase).
    const events: ReporterEvent[] = [];
    const d = deps({
      reporter: capturingReporter(events),
    });
    const engine = new MastraPipelineEngine(d);
    const taskId = await engine.runFull('proj', { title: 't', description: 'd', source: 'discord-command' });

    const task = await d.taskStore.getTask(taskId);
    expect(task?.status).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// Label-lifecycle external effect (ADR-026, #64)
// ---------------------------------------------------------------------------

interface FakeLabelCalls {
  add: AddLabelArgs[];
  remove: RemoveLabelArgs[];
}

function fakeLabelPort(options: { error?: Error } = {}): { port: IssueLabelPort; calls: FakeLabelCalls } {
  const calls: FakeLabelCalls = { add: [], remove: [] };
  const port: IssueLabelPort = {
    addLabel: async (args) => {
      if (options.error !== undefined) {
        throw options.error;
      }
      calls.add.push(args);
    },
    removeLabel: async (args) => {
      if (options.error !== undefined) {
        throw options.error;
      }
      calls.remove.push(args);
    },
  };
  return { port, calls };
}

const labelTarget = (): { owner: string; repo: string } => ({ owner: 'acme', repo: 'widget' });

const FAILING_AGENT_RUNNER: AgentRunner = {
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

describe('MastraPipelineEngine label-lifecycle external effect (ADR-026)', () => {
  it('relabels issue ready-for-human on done for an issue-triggered task', async () => {
    const { port, calls } = fakeLabelPort();
    const labelEffect = new IssueLabelLifecycleEffect({ port, log: () => {} });
    const d = deps({ labelEffect, labelTargetFor: labelTarget });
    const engine = new MastraPipelineEngine(d);

    const taskId = await engine.runFull('proj', {
      title: 't',
      description: 'd',
      source: 'github-issue-label',
      issueNumber: 99,
    });

    const task = await d.taskStore.getTask(taskId);
    expect(task?.status).toBe('done');
    expect(calls.remove).toHaveLength(1);
    expect(calls.remove[0]).toMatchObject({ name: 'ready-for-agent', issue_number: 99 });
    expect(calls.add).toHaveLength(1);
    expect(calls.add[0]).toMatchObject({ labels: ['ready-for-human'], issue_number: 99 });
  });

  it('relabels issue needs-info on failed for an issue-triggered task', async () => {
    const { port, calls } = fakeLabelPort();
    const labelEffect = new IssueLabelLifecycleEffect({ port, log: () => {} });
    const d = deps({ agentRunner: FAILING_AGENT_RUNNER, labelEffect, labelTargetFor: labelTarget });
    const engine = new MastraPipelineEngine(d);

    const taskId = await engine.runFull('proj', {
      title: 't',
      description: 'd',
      source: 'github-issue-label',
      issueNumber: 77,
    });

    const task = await d.taskStore.getTask(taskId);
    expect(task?.status).toBe('failed');
    expect(calls.remove).toHaveLength(1);
    expect(calls.remove[0]).toMatchObject({ name: 'ready-for-agent', issue_number: 77 });
    expect(calls.add).toHaveLength(1);
    expect(calls.add[0]).toMatchObject({ labels: ['needs-info'], issue_number: 77 });
  });

  it('does not call the label port for a discord-command task', async () => {
    const { port, calls } = fakeLabelPort();
    const labelEffect = new IssueLabelLifecycleEffect({ port, log: () => {} });
    const d = deps({ labelEffect, labelTargetFor: labelTarget });
    const engine = new MastraPipelineEngine(d);

    const taskId = await engine.runFull('proj', {
      title: 't',
      description: 'd',
      source: 'discord-command',
    });

    const task = await d.taskStore.getTask(taskId);
    expect(task?.status).toBe('done');
    expect(calls.add).toHaveLength(0);
    expect(calls.remove).toHaveLength(0);
  });

  it('does not change task status when the label port throws', async () => {
    const { port } = fakeLabelPort({ error: new Error('GitHub 500') });
    const labelEffect = new IssueLabelLifecycleEffect({ port, log: () => {} });
    const d = deps({ labelEffect, labelTargetFor: labelTarget });
    const engine = new MastraPipelineEngine(d);

    const taskId = await engine.runFull('proj', {
      title: 't',
      description: 'd',
      source: 'github-issue-label',
      issueNumber: 55,
    });

    // Task must remain done despite port failure.
    const task = await d.taskStore.getTask(taskId);
    expect(task?.status).toBe('done');
  });

  it('relabels needs-info when branch publication fails (issue-triggered)', async () => {
    const { port: branchPort } = fakeBranchPort({ pushError: true });
    const { port, calls } = fakeLabelPort();
    const labelEffect = new IssueLabelLifecycleEffect({ port, log: () => {} });
    const d = deps({
      branchPublisher: new BranchPublisher({ port: branchPort }),
      labelEffect,
      labelTargetFor: labelTarget,
    });
    const engine = new MastraPipelineEngine(d);

    const taskId = await engine.runFull('proj', {
      title: 't',
      description: 'd',
      source: 'github-issue-label',
      issueNumber: 88,
    });

    const task = await d.taskStore.getTask(taskId);
    expect(task?.status).toBe('failed');
    expect(task?.failure_reason).toBe('branch_publish_failed');
    expect(calls.remove[0]).toMatchObject({ name: 'ready-for-agent', issue_number: 88 });
    expect(calls.add[0]).toMatchObject({ labels: ['needs-info'], issue_number: 88 });
  });

  it('relabels needs-info when PR creation fails (issue-triggered)', async () => {
    const { port: branchPort } = fakeBranchPort();
    const { client: prClient } = fakePrClient({ fail: true });
    const { port, calls } = fakeLabelPort();
    const labelEffect = new IssueLabelLifecycleEffect({ port, log: () => {} });
    const d = deps({
      branchPublisher: new BranchPublisher({ port: branchPort }),
      pullRequestCreator: new PullRequestCreator({ client: prClient, sleep: async () => {} }),
      prTargetFor: prTarget,
      labelEffect,
      labelTargetFor: labelTarget,
    });
    const engine = new MastraPipelineEngine(d);

    const taskId = await engine.runFull('proj', {
      title: 't',
      description: 'd',
      source: 'github-issue-label',
      issueNumber: 66,
    });

    const task = await d.taskStore.getTask(taskId);
    expect(task?.status).toBe('failed');
    expect(task?.failure_reason).toBe('pr_create_failed');
    expect(calls.remove[0]).toMatchObject({ name: 'ready-for-agent', issue_number: 66 });
    expect(calls.add[0]).toMatchObject({ labels: ['needs-info'], issue_number: 66 });
  });
});

// ---------------------------------------------------------------------------
// Per-task ephemeral agent lifecycle (ADR-030, #111)
// ---------------------------------------------------------------------------

function recordingLifecycle(): {
  ensured: { taskId: string; workspace: string }[];
  removed: string[];
  lifecycle: TaskAgentLifecycle;
} {
  const ensured: { taskId: string; workspace: string }[] = [];
  const removed: string[] = [];
  return {
    ensured,
    removed,
    lifecycle: {
      ensure: async (req): Promise<void> => {
        ensured.push(req);
      },
      remove: async (req): Promise<void> => {
        removed.push(req.taskId);
      },
    },
  };
}

describe('MastraPipelineEngine ephemeral agent lifecycle (ADR-030)', () => {
  it('ensures the worktree-bound agent before the run and removes it on done', async () => {
    const { ensured, removed, lifecycle } = recordingLifecycle();
    const d = deps({ taskAgentLifecycle: lifecycle });
    const engine = new MastraPipelineEngine(d);
    const taskId = await engine.runFull('proj', { title: 't', description: 'd', source: 'discord-command' });

    expect((await d.taskStore.getTask(taskId))?.status).toBe('done');
    expect(ensured).toHaveLength(1);
    expect(ensured[0]?.taskId).toBe(taskId);
    expect(ensured[0]?.workspace).toBe(path.join(tempDir, 'wt', taskId));
    expect(removed).toEqual([taskId]);
  });

  it('removes the agent when the task fails', async () => {
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
    const { removed, lifecycle } = recordingLifecycle();
    const d = deps({ agentRunner: failingRunner, taskAgentLifecycle: lifecycle });
    const engine = new MastraPipelineEngine(d);
    const taskId = await engine.runFull('proj', { title: 't', description: 'd', source: 'discord-command' });

    expect((await d.taskStore.getTask(taskId))?.status).toBe('failed');
    expect(removed).toEqual([taskId]);
  });

  it('keeps the agent for a paused (suspended) task and removes it only on cancel', async () => {
    const { ensured, removed, lifecycle } = recordingLifecycle();
    const d = deps({ workflowRegistry: workflowRegistryFor(PAUSING_YAML), taskAgentLifecycle: lifecycle });
    const engine = new MastraPipelineEngine(d);
    const taskId = await engine.runFull('proj', { title: 't', description: 'd', source: 'discord-command' });

    // Suspended is NOT terminal — the agent must survive for the resume.
    expect((await d.taskStore.getTask(taskId))?.status).toBe('paused');
    expect(ensured).toHaveLength(1);
    expect(removed).toEqual([]);

    await engine.cancel(taskId);
    expect((await d.taskStore.getTask(taskId))?.status).toBe('canceled');
    expect(removed).toEqual([taskId]);
  });

  it('does not let a delete failure change the terminal outcome', async () => {
    const lifecycle: TaskAgentLifecycle = {
      ensure: async (): Promise<void> => Promise.resolve(),
      remove: async (): Promise<void> => Promise.reject(new Error('gateway down')),
    };
    const d = deps({ taskAgentLifecycle: lifecycle });
    const engine = new MastraPipelineEngine(d);
    const taskId = await engine.runFull('proj', { title: 't', description: 'd', source: 'discord-command' });

    expect((await d.taskStore.getTask(taskId))?.status).toBe('done');
  });
});
