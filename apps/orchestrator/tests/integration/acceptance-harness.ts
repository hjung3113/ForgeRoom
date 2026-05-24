/**
 * Phase 1 acceptance-matrix shared harness (#32).
 *
 * Assembles the REAL Phase 1 stack — MastraPipelineEngine + FileConductor +
 * DefaultCheckRunner + ForgeMapStagerImpl + DefaultAgentRunner over the real
 * OpenClawProvider + SqliteTaskStore + OrchestratorGatewayPortImpl — against a
 * real temp SQLite file and a real temp `.forgeroom/` worktree tree. Only the
 * EXTERNAL I/O boundaries are faked (per testing-rules):
 *   - OpenClaw IPC      → {@link FakeOpenClawIpc} (writes the output file the
 *                          AgentRunner/engine then read back, models a headless run)
 *   - target-repo git   → {@link FakeRepoStateProbe} (HEAD + dirty flag)
 *   - conductor git      → {@link FakeConductorGit} (status/revert snapshot)
 *   - project commands   → {@link FakeCommandRunner} (lint/typecheck/test exit codes)
 *   - Reporter sinks      → in-memory event recorder
 *   - PR creator          → in-memory fake
 *
 * The engine, conductor, check-runner, gateway facade and recoverPending paths
 * are the REAL implementations — this is the e2e seam the matrix exercises.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { createTaskStoreDatabase, migrateTaskStoreDatabase } from '../../src/db/client.js';
import { SqliteTaskStore } from '../../src/db/sqlite-task-store.js';
import { IntentRegistry } from '../../src/core/intent-registry.js';
import { ProjectRegistry } from '../../src/core/project-registry.js';
import { WorkflowRegistry } from '../../src/core/workflow-registry.js';
import { AgentRegistry } from '../../src/core/agent-registry.js';
import { HarnessRegistry } from '../../src/core/harness-registry.js';
import { ApprovalGate } from '../../src/core/approval-gate.js';
import { DefaultAgentRunner } from '../../src/core/agent-runner.js';
import { OpenClawProvider } from '../../src/core/openclaw-provider.js';
import { DefaultCheckRunner } from '../../src/core/check-runner.js';
import {
  AgentRunnerConductorAgent,
  FileConductor,
  type ConductorGit,
} from '../../src/core/conductor.js';
import {
  ForgeMapStagerImpl,
  type ForgeMapStore,
  type RepoStateProbe,
  type TaskContextLookup,
} from '../../src/core/forgemap.js';
import {
  MastraPipelineEngine,
  FileSnapshotBridge,
  type PipelineEngineDeps,
  type PullRequestTarget,
  type WorkflowSourceProvider,
} from '../../src/core/pipeline-engine.js';
import { OrchestratorGatewayPortImpl } from '../../src/app/gateway-port.js';
import type {
  OpenClawExecutionRequest,
  OpenClawIpcClient,
  OpenClawResumeRequest,
  OpenClawRunResponse,
} from '../../src/core/openclaw-provider.js';
import type { ProviderHealth } from '../../src/core/agent-runner.js';
import type { CommandRunner, CommandRunnerInput, CommandRunnerResult } from '../../src/utils/command-runner.js';
import type {
  PullRequestCreator,
  PullRequestEffectRequest,
  PullRequestEffectResult,
} from '../../src/core/pull-request-creator.js';
import type { Event, Reporter, ReporterEvent, Task } from '../../src/core/types.js';

// ---------------------------------------------------------------------------
// Registries — one project, the three provided workflows + a custom workflow.
// ---------------------------------------------------------------------------

export const INTENTS = {
  claude_write_plan: { kind: 'write_plan', agent: 'claude', harness: 'planning' },
  codex_execute: { kind: 'execute', agent: 'codex', harness: 'implementation' },
  claude_review: { kind: 'review', agent: 'claude', harness: 'review' },
} as const;

// `quick`: plan -> implement(execute -> CheckRunner) -> review_loop.
export const QUICK_YAML = `
quick:
  description: quick
  effects:
    worktree: modifies
    external:
      report: status
      pr: ready
  steps:
    - type: run
      id: plan
      intent: claude_write_plan
      prompt_template: implementation_plan.md
      output_selectors: [slices]
    - type: run
      id: implement
      intent: codex_execute
      prompt_template: execute.md
      input_refs:
        plan: \${plan.output_path}
    - type: review_loop
      id: quality
      max_iterations: 2
      until: \${review.passed}
      review:
        id: review
        intent: claude_review
        prompt_template: review_diff.md
        input_refs:
          diff: \${implement.diff_path}
      refine:
        id: refine
        intent: codex_execute
        prompt_template: refine_from_review.md
        input_refs:
          review: \${review.output_path}
`;

// `hotfix`: a two-run linear workflow (execute -> review).
export const HOTFIX_YAML = `
hotfix:
  description: hotfix
  effects:
    worktree: modifies
    external:
      report: status
      pr: ready
  steps:
    - type: run
      id: fix
      intent: codex_execute
      prompt_template: hotfix.md
    - type: run
      id: review
      intent: claude_review
      prompt_template: review_hotfix.md
`;

// `full`: plan -> refine -> foreach slices(execute) -> final review_loop.
export const FULL_YAML = `
full:
  description: full
  effects:
    worktree: modifies
    external:
      report: status
      pr: ready
  steps:
    - type: run
      id: impl_plan
      intent: claude_write_plan
      prompt_template: implementation_plan.md
      output_selectors: [slices]
    - type: run
      id: impl_plan_refine
      intent: claude_write_plan
      prompt_template: refine_plan.md
      input_refs:
        original: \${impl_plan.output_path}
    - type: group
      id: slices
      foreach: \${task.final_slices}
      as: slice
      steps:
        - type: run
          id: slice_impl
          intent: codex_execute
          prompt_template: slice_impl.md
          input_refs:
            slice: \${slice}
    - type: review_loop
      id: final_quality
      max_iterations: 2
      until: \${final_review.passed}
      review:
        id: final_review
        intent: claude_review
        prompt_template: final_review.md
      refine:
        id: final_refine
        intent: codex_execute
        prompt_template: final_refine.md
        input_refs:
          review: \${final_review.output_path}
`;

// A "custom" workflow a project author selected from allowed_workflows. Single
// execute step with a trailing pause gate so we can drive pause/resume too.
export const CUSTOM_YAML = `
custom:
  description: custom selected workflow
  effects:
    worktree: modifies
    external:
      report: status
      pr: draft
  steps:
    - type: run
      id: build
      intent: codex_execute
      prompt_template: build.md
    - type: run
      id: wrapup
      intent: claude_write_plan
      prompt_template: wrap.md
      pause_after: true
`;

// >= 50 bytes so the REAL AgentRunner's output-contract check passes.
export const PLAN_OUTPUT =
  '# Plan\n\nImplementation plan for this task.\n\n## Slices\n\n- first slice\n- second slice\n';
export const REVIEW_PASS = 'Review Result: pass\n\nlooks good now (padding bytes here too).';
export const REVIEW_FAIL = 'Review Result: fail\n\nmore work needed (padding bytes here).';

const ALL_WORKFLOWS: Record<string, string> = {
  quick: QUICK_YAML,
  hotfix: HOTFIX_YAML,
  full: FULL_YAML,
  custom: CUSTOM_YAML,
};

// ---------------------------------------------------------------------------
// External-I/O fakes
// ---------------------------------------------------------------------------

export interface AgentScript {
  /** Per-step content keyed by step_id (file base "NN_<step_id>"). */
  outputs: Record<string, string>;
  /** Steps whose first run writes NO output file (forces validation retry). */
  skipOutputUntilAttempt: Record<string, number>;
  /** Review step ids that fail until the Nth call, then pass. */
  reviewFailUntilCall: Record<string, number>;
}

/**
 * Fake OpenClaw IPC: models a headless agent run by WRITING the requested output
 * file (the real provider only relays exists/bytes; the engine reads the file
 * back). The output instruction carries the absolute output path.
 */
export class FakeOpenClawIpc implements OpenClawIpcClient {
  readonly agentCalls: string[] = [];
  private readonly reviewCalls: Record<string, number> = {};
  private readonly attemptByStep: Record<string, number> = {};

  constructor(private readonly script: AgentScript) {}

  health(): Promise<ProviderHealth> {
    return Promise.resolve({ ok: true, message: 'fake' });
  }

  async run(request: OpenClawExecutionRequest): Promise<OpenClawRunResponse> {
    return this.execute(request);
  }

  async resume(request: OpenClawResumeRequest): Promise<OpenClawRunResponse> {
    return this.execute(request);
  }

  private async execute(request: OpenClawExecutionRequest): Promise<OpenClawRunResponse> {
    const outputPath = request.outputPath;
    const stepId = stepIdFromOutputPath(outputPath);
    this.agentCalls.push(stepId);

    const attempt = (this.attemptByStep[stepId] = (this.attemptByStep[stepId] ?? 0) + 1);
    const skipUntil = this.script.skipOutputUntilAttempt[stepId];
    const writeNow = skipUntil === undefined || attempt >= skipUntil;

    let content: string;
    const reviewUntil = this.script.reviewFailUntilCall[stepId];
    if (reviewUntil !== undefined) {
      const call = (this.reviewCalls[stepId] = (this.reviewCalls[stepId] ?? 0) + 1);
      content = call >= reviewUntil ? REVIEW_PASS : REVIEW_FAIL;
    } else {
      content = this.script.outputs[stepId] ?? `# ${stepId}\n\nautomated output for ${stepId} (>=50 bytes padding here).`;
    }

    if (writeNow) {
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, content);
    }

    return {
      exitCode: 0,
      output: { exists: writeNow, bytes: writeNow ? Buffer.byteLength(content) : 0 },
      durationMs: 1,
      sessionId: 'session-1',
      stdoutPath: request.stdoutPath,
      stderrPath: request.stderrPath,
    };
  }
}

/** Fake target-repo git state probe (HEAD commit + dirty flag). */
export class FakeRepoStateProbe implements RepoStateProbe {
  constructor(public state: { commit: string; dirty: boolean } = { commit: 'abc123', dirty: false }) {}
  head(): Promise<{ commit: string; dirty: boolean }> {
    return Promise.resolve(this.state);
  }
}

/**
 * Fake ConductorGit driving the REAL FileConductor scope guard. By default
 * `status` reports a clean worktree (no violations). The test calls
 * {@link armViolation} immediately before the conductor call it wants to trip:
 * the guard snapshots `status` BEFORE the agent run (still clean) then AFTER
 * (the armed paths), so it detects the out-of-scope write and reverts it.
 */
export class FakeConductorGit implements ConductorGit {
  readonly reverted: string[][] = [];
  private armed: string[] | null = null;
  private sawBefore = false;

  /** Arm the NEXT guardedRun's post-call status to report these changed paths. */
  armViolation(paths: string[]): void {
    this.armed = paths;
    this.sawBefore = false;
  }

  status(): Promise<string[]> {
    if (this.armed === null) {
      return Promise.resolve([]);
    }
    if (!this.sawBefore) {
      // The "before" snapshot: still clean.
      this.sawBefore = true;
      return Promise.resolve([]);
    }
    // The "after" snapshot: the violation appears, then disarm.
    const paths = this.armed;
    this.armed = null;
    return Promise.resolve(paths);
  }

  revert(_cwd: string, paths: string[]): Promise<void> {
    this.reverted.push(paths);
    return Promise.resolve();
  }
}

/** Fake project-command runner with per-command exit codes (lint/typecheck/test). */
export class FakeCommandRunner implements CommandRunner {
  readonly runs: string[] = [];
  /** Exit code by attempt index per command name; default 0. */
  constructor(private readonly failFirstAttempt = false) {}
  private attempts = 0;

  async run(input: CommandRunnerInput): Promise<CommandRunnerResult> {
    this.runs.push(input.command);
    // Optionally fail the very first batch (attempt 0) so CheckRunner retries.
    const exitCode = this.failFirstAttempt && this.attempts < commandCountGuess ? 1 : 0;
    this.attempts += 1;
    await mkdir(path.dirname(input.stdoutPath), { recursive: true });
    await writeFile(input.stdoutPath, 'out');
    await writeFile(input.stderrPath, exitCode === 0 ? '' : 'boom');
    return {
      command: input.command,
      exitCode,
      durationMs: 1,
      stdoutPath: input.stdoutPath,
      stderrPath: input.stderrPath,
      timedOut: false,
    };
  }
}

const commandCountGuess = 3; // lint/typecheck/test — first batch fails, then passes.

/** In-memory fake PR creator (records the ensure call, returns a stable ref). */
export class FakePullRequestCreator implements Pick<PullRequestCreator, 'ensure'> {
  readonly ensured: PullRequestEffectRequest[] = [];
  ensure(request: PullRequestEffectRequest): Promise<PullRequestEffectResult> {
    this.ensured.push(request);
    return Promise.resolve({
      ref: { number: 42, url: 'https://example.test/pr/42' },
      via: request.prNumber === null ? 'created' : 'reused_by_number',
    });
  }
}

// ---------------------------------------------------------------------------
// Harness assembly
// ---------------------------------------------------------------------------

export interface HarnessOptions {
  /** Workflows the project allows. Default: all four. */
  allowedWorkflows?: string[];
  /** Default workflow id. Default: quick. */
  defaultWorkflow?: string;
  agentScript?: Partial<AgentScript>;
  /** Whether the first CheckRunner batch fails (forces a check-fix retry). */
  failChecksFirstAttempt?: boolean;
  /**
   * Resolve the per-task dirty-baseline approver from the shared approvals map
   * the gateway records into. Default: never approved (production-equivalent).
   * The dirty-baseline test injects {@link approvalAwareLookup}.
   */
  taskLookup?: (input: { store: SqliteTaskStore; approvals: Map<string, string> }) => TaskContextLookup;
  repoState?: { commit: string; dirty: boolean };
}

export interface AcceptanceHarness {
  engine: MastraPipelineEngine;
  gatewayPort: OrchestratorGatewayPortImpl;
  store: SqliteTaskStore;
  conductor: FileConductor;
  conductorGit: FakeConductorGit;
  openClaw: FakeOpenClawIpc;
  commandRunner: FakeCommandRunner;
  prCreator: FakePullRequestCreator;
  repoProbe: FakeRepoStateProbe;
  reporterEvents: ReporterEvent[];
  conductorLog: string[];
  /** Dirty-baseline approvals recorded via the gateway (taskId -> approver). */
  approvals: Map<string, string>;
  worktreeRoot: string;
  worktreePathFor: (taskId: string) => string;
  /** Rebuild the engine + gateway (simulated process restart, same on-disk state). */
  rebuild: () => AcceptanceHarness;
  cleanup: () => Promise<void>;
}

export async function makeHarness(options: HarnessOptions = {}): Promise<AcceptanceHarness> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'accept-matrix-'));
  return assemble(tempDir, options);
}

function assemble(tempDir: string, options: HarnessOptions): AcceptanceHarness {
  const projectPath = path.join(tempDir, 'project');
  const worktreeRoot = path.join(tempDir, 'worktrees');
  const snapshotDir = path.join(tempDir, 'snapshots');

  const database = createTaskStoreDatabase(path.join(tempDir, 'forgeroom.sqlite'));
  migrateTaskStoreDatabase(database);
  const store = new SqliteTaskStore(database);

  const allowed = options.allowedWorkflows ?? ['quick', 'hotfix', 'full', 'custom'];
  const defaultWorkflow = options.defaultWorkflow ?? 'quick';
  // Shared dirty-baseline approvals (taskId -> approver) the gateway records into.
  const approvals = new Map<string, string>();

  const script: AgentScript = {
    // Plan steps emit the `## Slices` contract; standalone review steps emit the
    // `Review Result: pass` contract by default (overridable per test, and
    // reviewFailUntilCall takes precedence for review_loop fail-then-pass cases).
    outputs: {
      plan: PLAN_OUTPUT,
      impl_plan: PLAN_OUTPUT,
      review: REVIEW_PASS,
      final_review: REVIEW_PASS,
      ...(options.agentScript?.outputs ?? {}),
    },
    skipOutputUntilAttempt: options.agentScript?.skipOutputUntilAttempt ?? {},
    reviewFailUntilCall: options.agentScript?.reviewFailUntilCall ?? {},
  };

  const reporterEvents: ReporterEvent[] = [];
  const conductorLog: string[] = [];

  const openClaw = new FakeOpenClawIpc(script);
  const provider = new OpenClawProvider({ endpoint: 'http://x', token: 'tok', runtime: 'claude-cli', agentId: 'main', client: openClaw });

  const harnessRegistry = HarnessRegistry.fromConfig({
    planning: { source: 'planning' },
    implementation: { source: 'implementation' },
    review: { source: 'review' },
  });
  const agentRegistry = AgentRegistry.fromConfig(
    {
      claude: { provider: 'openclaw', runtime: 'claude-cli', model: 'anthropic/claude', harness: 'planning' },
      codex: { provider: 'openclaw', runtime: 'openai-codex', model: 'openai/gpt', harness: 'implementation' },
    },
    harnessRegistry,
  );
  const intentRegistry = IntentRegistry.fromConfig(INTENTS);
  // The ProjectRegistry validates allowed_workflows against the WorkflowRegistry,
  // so every workflow id the project allows must be registered here. The engine
  // executes from the raw YAML in `workflowSource`; these structural entries only
  // satisfy the registry's existence + shape check.
  const minimalWorkflow = {
    description: 'matrix workflow',
    effects: { worktree: 'modifies' as const, external: { report: 'status' as const, pr: 'ready' as const } },
    steps: [{ type: 'run' as const, id: 'plan', intent: 'claude_write_plan', prompt_template: 'plan.md' }],
  };
  const workflowRegistry = WorkflowRegistry.fromConfig(
    { quick: minimalWorkflow, hotfix: minimalWorkflow, full: minimalWorkflow, custom: minimalWorkflow },
    { intentRegistry, agentRegistry, harnessRegistry },
    { templateExists: () => true },
  );
  const projectRegistry = ProjectRegistry.fromConfig(
    {
      forgeroom: {
        path: projectPath,
        default_branch: 'main',
        package_manager: 'pnpm',
        default_workflow: defaultWorkflow,
        allowed_workflows: allowed,
        commands: { lint: 'echo lint', typecheck: 'echo tc', test: 'echo test' },
        maintainers: { discord_user_ids: ['111'], github_logins: ['octocat'] },
      },
    },
    workflowRegistry,
    { projectPathExists: () => true },
  );

  const agentRunner = new DefaultAgentRunner({ agentRegistry, provider, maxAttempts: 3 });

  const conductorGit = new FakeConductorGit();
  const conductor = new FileConductor({
    agent: new AgentRunnerConductorAgent({ agentRunner, agentId: 'claude' }),
    git: conductorGit,
    taskStore: store,
    log: (line) => conductorLog.push(line),
  });

  const repoProbe = new FakeRepoStateProbe(options.repoState ?? { commit: 'abc123', dirty: false });
  const taskLookup: TaskContextLookup =
    options.taskLookup?.({ store, approvals }) ?? defaultLookup(store, workflowRegistry);
  const forgeMap = new ForgeMapStagerImpl({
    store: bootstrapStore(projectPath, repoProbe),
    repoProbe,
    taskLookup,
  });

  const reporter: Reporter = {
    flushUndelivered: () => Promise.resolve(),
    notify: async (event) => {
      reporterEvents.push(event);
      return Promise.resolve();
    },
  };

  const commandRunner = new FakeCommandRunner(options.failChecksFirstAttempt ?? false);
  const approvalGate = new ApprovalGate();
  const checkRunner = new DefaultCheckRunner({
    commandRunner,
    agentRunner,
    taskStore: store,
    approvalGate,
    artifactStore: {
      readFile: (p) => readFile(p, 'utf8'),
      writeFile: (p, content) => writeFile(p, content),
    },
  });

  const prCreator = new FakePullRequestCreator();

  const workflowSource: WorkflowSourceProvider = {
    source: (workflowId) => {
      const yaml = ALL_WORKFLOWS[workflowId];
      if (yaml === undefined) {
        throw new Error(`no workflow source for ${workflowId}`);
      }
      return yaml;
    },
  };

  const worktreeManager = {
    create: async (task: Task): Promise<{ path: string; branch: string }> => {
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
    ensureForgeroomDir: () => Promise.resolve(),
  } as unknown as PipelineEngineDeps['worktreeManager'];

  const prTargetFor = (): PullRequestTarget => ({ owner: 'octocat', repo: 'demo', base: 'main' });

  const deps: PipelineEngineDeps = {
    projectRegistry,
    intentRegistry,
    taskStore: store,
    worktreeManager,
    agentRunner,
    checkRunner,
    conductor,
    approvalGate,
    reporter,
    forgeMap,
    workflowSource,
    snapshotBridge: new FileSnapshotBridge(snapshotDir),
    pullRequestCreator: prCreator as unknown as PullRequestCreator,
    prTargetFor,
    allowedWorktreeRoots: [worktreeRoot],
    worktreePathFor: ({ taskId }) => path.join(worktreeRoot, taskId),
    branchFor: ({ taskId }) => `forge/${taskId}`,
    mastraVersion: '1.36.0',
    log: () => {},
  };

  const engine = new MastraPipelineEngine(deps);
  const gatewayPort = new OrchestratorGatewayPortImpl({
    engine,
    conductor,
    taskStore: store,
    recordApprovalEvent: (taskId, approvedBy) => {
      approvals.set(taskId, approvedBy);
      return enqueuePlainEvent(store, taskId, 'dirty_baseline_approved', { approvedBy });
    },
    recordFeedbackEvent: (taskId, message) => enqueuePlainEvent(store, taskId, 'user_feedback', { message }),
  });

  const worktreePathFor = (taskId: string): string => path.join(worktreeRoot, taskId);

  const rebuild = (): AcceptanceHarness => {
    const engine2 = new MastraPipelineEngine({ ...deps, snapshotBridge: new FileSnapshotBridge(snapshotDir) });
    const gatewayPort2 = new OrchestratorGatewayPortImpl({
      engine: engine2,
      conductor,
      taskStore: store,
      recordApprovalEvent: (taskId, approvedBy) => {
        approvals.set(taskId, approvedBy);
        return enqueuePlainEvent(store, taskId, 'dirty_baseline_approved', { approvedBy });
      },
      recordFeedbackEvent: (taskId, message) => enqueuePlainEvent(store, taskId, 'user_feedback', { message }),
    });
    return {
      engine: engine2,
      gatewayPort: gatewayPort2,
      store,
      conductor,
      conductorGit,
      openClaw,
      commandRunner,
      prCreator,
      repoProbe,
      reporterEvents,
      conductorLog,
      approvals,
      worktreeRoot,
      worktreePathFor,
      rebuild,
      cleanup,
    };
  };

  const cleanup = async (): Promise<void> => {
    database.close();
    await rm(tempDir, { recursive: true, force: true });
  };

  return {
    engine,
    gatewayPort,
    store,
    conductor,
    conductorGit,
    openClaw,
    commandRunner,
    prCreator,
    repoProbe,
    reporterEvents,
    conductorLog,
    approvals,
    worktreeRoot,
    worktreePathFor,
    rebuild,
    cleanup,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultLookup(store: SqliteTaskStore, workflowRegistry: WorkflowRegistry): TaskContextLookup {
  return {
    forTask: async (taskId) => {
      const task = await store.getTask(taskId);
      if (task === null) {
        throw new Error(`lookup: unknown task ${taskId}`);
      }
      const workflow = workflowRegistry.get(task.workflow_id);
      return {
        title: task.title,
        description: task.description,
        worktreeKind: workflow?.effects.worktree === 'read_only' ? 'read_only' : 'modifies',
        dirtyBaselineApprovedBy: null,
        pendingRebuildApprovedBy: null,
        changedPaths: [],
      };
    },
  };
}

/**
 * Models the ADR-013 dirty-baseline read-back for the #32 engine/stager e2e: it
 * reflects a recorded approval (here via the shared approvals map the gateway
 * writes) so an approved task proceeds. The production `TaskStoreContextLookup`
 * now performs the equivalent read from TaskStore events (#42); its real
 * read-back path is covered by `dirty-baseline-real-lookup.test.ts`.
 */
export function approvalAwareLookup(input: {
  store: SqliteTaskStore;
  approvals: Map<string, string>;
}): TaskContextLookup {
  const { store, approvals } = input;
  return {
    forTask: async (taskId) => {
      const task = await store.getTask(taskId);
      if (task === null) {
        throw new Error(`lookup: unknown task ${taskId}`);
      }
      // A '*' entry models a maintainer pre-approving the dirty baseline before
      // the task id is minted (runFull stages synchronously on its own id).
      const approvedBy = approvals.get(taskId) ?? approvals.get('*') ?? null;
      return {
        title: task.title,
        description: task.description,
        worktreeKind: 'modifies',
        dirtyBaselineApprovedBy: approvedBy,
        pendingRebuildApprovedBy: null,
        changedPaths: [],
      };
    },
  };
}

function bootstrapStore(projectPath: string, repoProbe: RepoStateProbe): ForgeMapStore {
  return {
    get: () => Promise.resolve(null),
    build: async (projectId) => {
      const head = await repoProbe.head(projectPath);
      return {
        projectId,
        source: {
          repoPath: projectPath,
          defaultBranch: 'main',
          indexedCommit: head.commit,
          indexedDirty: head.dirty,
          indexedAt: new Date().toISOString(),
        },
        docs: [
          {
            purpose: 'project-profile',
            relPath: 'project-profile.md',
            content: `# ${projectId}\n\n(bootstrap profile)\n`,
            summary: `Bootstrap profile for ${projectId}`,
            keywords: [projectId],
          },
        ],
      };
    },
  };
}

function enqueuePlainEvent(
  store: SqliteTaskStore,
  taskId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const event: Event = { id: randomUUID(), task_id: taskId, type, payload, created_at: new Date() };
  return store.enqueueEvent(event).then(() => undefined);
}

function stepIdFromOutputPath(outputPath: string): string {
  // Conductor calls write under .forgeroom/prompts/conductor/<callKind>.<id>.output.md
  // → key the script by the call kind (refine/update/integrateFeedback/answer).
  const normalized = outputPath.split(path.sep).join('/');
  if (normalized.includes('/.forgeroom/prompts/conductor/')) {
    const file = path.basename(normalized); // "<callKind>.<id>.output.md"
    return file.split('.')[0] ?? file;
  }
  // CheckRunner fix outputs: .forgeroom/outputs/check_fix_<step>.md
  const base = path.basename(normalized, path.extname(normalized));
  if (base.startsWith('check_fix_')) {
    return base; // distinct key so check-fix runs don't collide with the step.
  }
  // Step outputs: .forgeroom/outputs/NN_<step_id>.md
  return base.replace(/^\d+_/, '');
}
