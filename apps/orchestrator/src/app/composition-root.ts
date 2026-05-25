/**
 * Composition root (#30) — the orchestrator's single wiring point.
 *
 * Assembles every module built in #25–#29 into a runnable orchestrator:
 *   configs/*.yaml ──► registries (#7)
 *                       │
 *   env (isolated) ──► SQLite TaskStore (#3) ──► Conductor (#4) · WorktreeManager (#5)
 *                       │                         AgentRunner over OpenClawProvider (ADR-012)
 *                       │                         CheckRunner (#19) · ApprovalGate (#16)
 *                       │                         ForgeMapStager (#26) · Reporter (#25)
 *                       │                         PullRequestCreator (#29)
 *                       ▼
 *                    PipelineEngine (#8)  ◄── ApprovalGate placed BOTH pre-Mastra
 *                       │                      (worktree admission, in runFull) AND
 *                       │                      in-step (agent command, in the adapter body)
 *                       ▼
 *                    OrchestratorGatewayPort facade
 *                       │
 *            ┌──────────┴───────────┐
 *        DiscordGateway (#27)   GitHubIssueTaskSource (#28)   ── the TaskSources
 *
 * Boot lifecycle ({@link OrchestratorApp.boot}):
 *   1. wire everything (this module, synchronous),
 *   2. `reporter.flushUndelivered()` + `engine.recoverPending()` (restart recovery),
 *   3. start the TaskSources (gated on credentials / `startSources`).
 *
 * Studio is NEVER launched here — `mastra dev` is a separate dev-only script
 * (ADR-015). The production boot path only constructs the runtime Mastra
 * instances the PipelineEngine builds per run.
 */
import { randomUUID } from 'node:crypto';

import { DefaultAgentRunner, type AgentRunner } from '../core/agent-runtime/agent-runner.js';
import { ApprovalGate } from '../core/checks/approval-gate.js';
import { DefaultCheckRunner } from '../core/checks/check-runner.js';
import {
  AgentRunnerConductorAgent,
  FileConductor,
} from '../core/conductor/conductor.js';
import { ForgeMapStagerImpl } from '../core/context/forgemap.js';
import { OpenClawProvider, type OpenClawIpcClient } from '../core/agent-runtime/openclaw-provider.js';
import {
  FileSnapshotBridge,
  MastraPipelineEngine,
  type PipelineEngine,
  type PipelineEngineDeps,
  type PullRequestTarget,
} from '../core/engine/pipeline-engine.js';
import { PullRequestCreator } from '../core/effects/pull-request-creator.js';
import { IssueLabelLifecycleEffect } from '../core/effects/issue-label-lifecycle.js';
import { GitHubIssueLabelClient } from '../gateway/github/issue-label-client.js';
import {
  DiscordReporterSink,
  GitHubReporterSink,
  OutboxReporter,
  type DiscordStatusClient,
  type GitHubStatusClient,
  type ReporterStore,
} from '../core/reporting/reporter.js';
import type { TaskStore } from '../core/task-store.js';
import type {
  Conductor,
  Event,
  ReporterSink,
  Task,
  TaskRequest,
} from '../core/types.js';
import { WorktreeManager } from '../core/worktree/worktree-manager.js';
import { NodeCommandRunner } from '../utils/command-runner.js';
import { readFile, writeFile } from 'node:fs/promises';

import { DiscordGateway } from '../gateway/discord-gateway.js';
import {
  GitHubIssueTaskSource,
  GitHubPullRequestClient,
  type GitHubOctokitLike,
} from '../gateway/github-gateway.js';
import { createGitHubClient } from '../gateway/github-client.js';
import { OctokitGitHubStatusClient } from '../gateway/github-status-client.js';

import { GitCliConductorGit } from './conductor-git.js';
import type { LoadedRegistries, OrchestratorEnv } from './config.js';
import {
  BootstrapForgeMapStore,
  GitCliRepoStateProbe,
  TaskStoreContextLookup,
} from './forgemap-adapters.js';
import { OrchestratorGatewayPortImpl } from './gateway-port.js';
import { OpenClawCliClient, resolveOpenClawCliConfig } from './openclaw-ipc.js';
import {
  GitCliWorktreeClient,
  NodeWorktreeFileSystem,
  type WorktreeRepoTarget,
} from './worktree-adapters.js';
import { branchFor, projectIdFromWorktreePath, worktreePathFor } from './worktree-naming.js';

const MASTRA_VERSION = '1.36.0';

// ---------------------------------------------------------------------------
// External-I/O override seam (tests inject fakes; production builds real ones)
// ---------------------------------------------------------------------------

/**
 * Overrides for the external-I/O adapters that need live credentials. The boot
 * integration test injects fakes here so it can compose + recover + start
 * sources without real Discord/GitHub/OpenClaw access (#31 exercises real
 * credentials). When an override is absent the composition root builds the real
 * SDK-backed adapter from the env.
 */
export interface ExternalAdapterOverrides {
  openClawIpcClient?: OpenClawIpcClient;
  discordStatusClient?: DiscordStatusClient;
  /** A GitHub status client per `owner/repo`, keyed `owner/repo`. */
  gitHubStatusClientFor?: (owner: string, repo: string) => GitHubStatusClient;
  /** Octokit-like client for the issue source + PR client (keyed by repo). */
  gitHubOctokit?: GitHubOctokitLike;
  /**
   * Build the DiscordGateway. Defaults to the real discord.js-backed gateway;
   * the test injects one whose `start()` is observable without a live login.
   */
  buildDiscordGateway?: (port: OrchestratorGatewayPortImpl, env: OrchestratorEnv) => DiscordGatewayLike;
}

/** The DiscordGateway surface the composition root drives. */
export interface DiscordGatewayLike {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface ComposeOrchestratorOptions {
  registries: LoadedRegistries;
  env: OrchestratorEnv;
  taskStore: TaskStore;
  overrides?: ExternalAdapterOverrides;
  /** Logger sink; defaults to stderr. */
  log?: (line: string) => void;
}

export interface BootOptions {
  /** Start the TaskSources after recovery. Default true. */
  startSources?: boolean;
}

interface RepoTarget {
  owner: string | null;
  repo: string | null;
  repoPath: string;
  baseBranch: string;
}

// ---------------------------------------------------------------------------
// Composed app
// ---------------------------------------------------------------------------

export interface OrchestratorApp {
  engine: PipelineEngine;
  conductor: Conductor;
  agentRunner: AgentRunner;
  reporter: OutboxReporter;
  gatewayPort: OrchestratorGatewayPortImpl;
  discordGateway: DiscordGatewayLike | null;
  gitHubSource: GitHubIssueTaskSource | null;
  /** True once boot() ran recoverPending. */
  recovered: boolean;
  /** Run the boot lifecycle: flush outbox, recoverPending, start sources. */
  boot(options?: BootOptions): Promise<void>;
  /** Stop the TaskSources (does not close the DB; callers own the store). */
  stop(): Promise<void>;
}

export function composeOrchestrator(options: ComposeOrchestratorOptions): OrchestratorApp {
  const { registries, env, taskStore } = options;
  const overrides = options.overrides ?? {};
  const log = options.log ?? ((line: string): void => void process.stderr.write(`${line}\n`));

  // --- AgentRunner over the real OpenClawProvider (ADR-012) ----------------
  const ipcClient =
    overrides.openClawIpcClient ??
    new OpenClawCliClient({
      config: resolveOpenClawCliConfig({
        cliBin: env.openclaw.cliBin,
        cliArgsJson: env.openclaw.cliArgsJson,
        agentId: env.openclaw.agentId,
      }),
    });
  const provider = new OpenClawProvider({
    endpoint: env.openclaw.endpoint,
    token: env.openclaw.token,
    runtime: env.openclaw.runtime,
    agentId: env.openclaw.agentId,
    client: ipcClient,
  });
  const agentRunner = new DefaultAgentRunner({
    agentRegistry: registries.agents,
    provider,
  });

  // --- Conductor (file-based, AgentRunner-backed) --------------------------
  const conductor: Conductor = new FileConductor({
    agent: new AgentRunnerConductorAgent({ agentRunner, agentId: conductorAgentId(registries) }),
    git: new GitCliConductorGit(),
    taskStore,
    log,
  });

  const repoTargetForProjectId = (projectId: string): RepoTarget | null => {
    const project = registries.projects.get(projectId);
    if (project === null) {
      return null;
    }
    const gitHubRepo = env.github?.repos.find((r) => r.projectId === projectId);
    return {
      owner: gitHubRepo?.owner ?? null,
      repo: gitHubRepo?.repo ?? null,
      repoPath: project.path,
      baseBranch: project.default_branch,
    };
  };

  const repoTargetForTask = (task: Task): RepoTarget | null => repoTargetForProjectId(task.project_id);

  const repoTargetForWorktreePath = (worktreePath: string): RepoTarget | null => {
    const root = matchingRoot(env.allowedWorktreeRoots, worktreePath);
    const projectId = root === null ? null : projectIdFromWorktreePath(root, worktreePath);
    return projectId === null ? null : repoTargetForProjectId(projectId);
  };

  // --- WorktreeManager (git CLI + node fs) ---------------------------------
  const resolveRepo = (worktreePath: string): WorktreeRepoTarget => {
    const target = repoTargetForWorktreePath(worktreePath);
    if (target === null) {
      throw new Error(`cannot resolve source repo for worktree path: ${worktreePath}`);
    }
    return { repoPath: target.repoPath, baseBranch: target.baseBranch };
  };
  const worktreeManager = new WorktreeManager({
    git: new GitCliWorktreeClient({ resolveRepo }),
    fileSystem: new NodeWorktreeFileSystem(),
  });

  // --- ForgeMap stager (real probe + lookup + bootstrap store) -------------
  const repoProbe = new GitCliRepoStateProbe();
  const forgeMap = new ForgeMapStagerImpl({
    store: new BootstrapForgeMapStore({ projectRegistry: registries.projects, repoProbe }),
    repoProbe,
    taskLookup: new TaskStoreContextLookup({
      taskStore,
      projectRegistry: registries.projects,
      workflowRegistry: registries.workflows,
    }),
  });

  // --- Reporter (outbox + per-destination sinks) ---------------------------
  const reporter = buildReporter({ taskStore, env, overrides, log });

  // --- CheckRunner ----------------------------------------------------------
  const approvalGate = new ApprovalGate();
  const checkRunner = new DefaultCheckRunner({
    commandRunner: new NodeCommandRunner(),
    agentRunner,
    taskStore,
    approvalGate,
    artifactStore: {
      readFile: (p: string): Promise<string> => readFile(p, 'utf8'),
      writeFile: (p: string, content: string): Promise<void> => writeFile(p, content),
    },
  });

  // --- PR external effect (ADR-019) ----------------------------------------
  const { pullRequestCreator, prTargetFor } = buildPullRequestEffect({ env, overrides, repoTargetForTask });

  // --- Label-lifecycle side-effect (ADR-026) ---------------------------------
  const { labelEffect, labelTargetFor } = buildLabelEffect({ env, overrides, repoTargetForTask, log });

  // --- PipelineEngine -------------------------------------------------------
  const engineDeps: PipelineEngineDeps = {
    projectRegistry: registries.projects,
    workflowRegistry: registries.workflows,
    intentRegistry: registries.intents,
    taskStore,
    worktreeManager,
    agentRunner,
    checkRunner,
    conductor,
    approvalGate,
    reporter,
    forgeMap,
    snapshotBridge: new FileSnapshotBridge(env.snapshotDir),
    ...(pullRequestCreator === null ? {} : { pullRequestCreator }),
    ...(prTargetFor === null ? {} : { prTargetFor }),
    ...(labelEffect === null ? {} : { labelEffect }),
    ...(labelTargetFor === null ? {} : { labelTargetFor }),
    allowedWorktreeRoots: env.allowedWorktreeRoots,
    worktreePathFor: (input): string =>
      worktreePathFor({ root: env.allowedWorktreeRoots[0] ?? '', projectId: input.projectId, taskId: input.taskId }),
    branchFor: (input): string => branchFor({ taskId: input.taskId, title: input.title }),
    mastraVersion: MASTRA_VERSION,
    log,
  };
  const engine = new MastraPipelineEngine(engineDeps);

  // --- Gateway facade + TaskSources ----------------------------------------
  const gatewayPort = new OrchestratorGatewayPortImpl({
    engine,
    conductor,
    taskStore,
    recordApprovalEvent: (taskId, approvedBy): Promise<void> =>
      enqueuePlainEvent(taskStore, taskId, 'dirty_baseline_approved', { approvedBy }),
    recordFeedbackEvent: (taskId, message): Promise<void> =>
      enqueuePlainEvent(taskStore, taskId, 'user_feedback', { message }),
  });

  const discordGateway = buildDiscordGateway({ gatewayPort, env, registries, overrides });
  const gitHubSource = buildGitHubSource({ gatewayPort, env, overrides, log });

  let recovered = false;

  return {
    engine,
    conductor,
    agentRunner,
    reporter,
    gatewayPort,
    discordGateway,
    gitHubSource,
    get recovered(): boolean {
      return recovered;
    },
    async boot(bootOptions?: BootOptions): Promise<void> {
      // 1. restart recovery: re-attempt undelivered Reporter rows, then resume
      //    or fresh-restart every active task (recoverPending, ADR-017).
      await reporter.flushUndelivered();
      await engine.recoverPending();
      recovered = true;
      // 2. start the TaskSources (gated on credentials / startSources).
      if (bootOptions?.startSources ?? true) {
        if (discordGateway !== null) {
          await discordGateway.start();
        }
        gitHubSource?.start();
      }
    },
    async stop(): Promise<void> {
      gitHubSource?.stop();
      if (discordGateway !== null) {
        await discordGateway.stop();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildReporter(input: {
  taskStore: TaskStore;
  env: OrchestratorEnv;
  overrides: ExternalAdapterOverrides;
  log: (line: string) => void;
}): OutboxReporter {
  const { taskStore, env, overrides, log } = input;
  const store: ReporterStore = {
    getTask: (id): Promise<Task | null> => taskStore.getTask(id),
    enqueueEvent: (e): ReturnType<TaskStore['enqueueEvent']> => taskStore.enqueueEvent(e),
    enqueueEventDelivery: (d): ReturnType<TaskStore['enqueueEventDelivery']> => taskStore.enqueueEventDelivery(d),
    markDeliveryDelivered: (id): Promise<void> => taskStore.markDeliveryDelivered(id),
    markDeliveryFailed: (id, patch): Promise<void> => taskStore.markDeliveryFailed(id, patch),
    listDueUndeliveredDeliveries: (now): ReturnType<TaskStore['listDueUndeliveredDeliveries']> =>
      taskStore.listDueUndeliveredDeliveries(now),
    getEvent: (id): ReturnType<TaskStore['getEvent']> => taskStore.getEvent(id),
    setExternalRef: (taskId, ref): Promise<void> => taskStore.setExternalRef(taskId, ref),
  };

  const sinks: ReporterSink[] = [];

  const discordClient = overrides.discordStatusClient ?? null;
  if (discordClient !== null) {
    sinks.push(new DiscordReporterSink(discordClient));
  }

  // GitHub status client is per-repo; the first configured repo's owner/repo is
  // used as the status surface scope (one status comment per task on its issue).
  if (env.github !== null && env.github.repos.length > 0) {
    const first = env.github.repos[0];
    if (first !== undefined) {
      const gitHubClient =
        overrides.gitHubStatusClientFor?.(first.owner, first.repo) ??
        new OctokitGitHubStatusClient({
          octokit: createGitHubClient(env.github.token),
          owner: first.owner,
          repo: first.repo,
        });
      sinks.push(new GitHubReporterSink(gitHubClient));
    }
  }

  if (sinks.length === 0) {
    log('reporter: no status sinks wired (no Discord client / GitHub repos); deliveries will be parked');
  }

  return new OutboxReporter({ store, sinks, log });
}

function buildPullRequestEffect(input: {
  env: OrchestratorEnv;
  overrides: ExternalAdapterOverrides;
  repoTargetForTask: (task: Task) => RepoTarget | null;
}): {
  pullRequestCreator: PullRequestCreator | null;
  prTargetFor: ((input: { task: Task }) => PullRequestTarget | null) | null;
} {
  const { env, overrides, repoTargetForTask } = input;
  if (env.github === null && overrides.gitHubOctokit === undefined) {
    return { pullRequestCreator: null, prTargetFor: null };
  }
  const octokit = overrides.gitHubOctokit ?? createGitHubClient(env.github?.token ?? '');
  const client = new GitHubPullRequestClient(octokit);
  const pullRequestCreator = new PullRequestCreator({ client });

  const prTargetFor = (target: { task: Task }): PullRequestTarget | null => {
    const repoTarget = repoTargetForTask(target.task);
    if (repoTarget === null || repoTarget.owner === null || repoTarget.repo === null) {
      return null;
    }
    return { owner: repoTarget.owner, repo: repoTarget.repo, base: repoTarget.baseBranch };
  };
  return { pullRequestCreator, prTargetFor };
}

function buildLabelEffect(input: {
  env: OrchestratorEnv;
  overrides: ExternalAdapterOverrides;
  repoTargetForTask: (task: Task) => RepoTarget | null;
  log: (line: string) => void;
}): {
  labelEffect: IssueLabelLifecycleEffect | null;
  labelTargetFor: ((task: Task) => { owner: string; repo: string } | null) | null;
} {
  const { env, overrides, repoTargetForTask, log } = input;
  if (env.github === null && overrides.gitHubOctokit === undefined) {
    return { labelEffect: null, labelTargetFor: null };
  }
  const octokit = overrides.gitHubOctokit ?? createGitHubClient(env.github?.token ?? '');
  const port = new GitHubIssueLabelClient(octokit);
  const effect = new IssueLabelLifecycleEffect({ port, log });

  const labelTargetFor = (task: Task): { owner: string; repo: string } | null => {
    const repoTarget = repoTargetForTask(task);
    if (repoTarget === null || repoTarget.owner === null || repoTarget.repo === null) {
      return null;
    }
    return { owner: repoTarget.owner, repo: repoTarget.repo };
  };
  return { labelEffect: effect, labelTargetFor };
}

function buildDiscordGateway(input: {
  gatewayPort: OrchestratorGatewayPortImpl;
  env: OrchestratorEnv;
  registries: LoadedRegistries;
  overrides: ExternalAdapterOverrides;
}): DiscordGatewayLike | null {
  const { gatewayPort, env, registries, overrides } = input;
  if (overrides.buildDiscordGateway !== undefined) {
    return overrides.buildDiscordGateway(gatewayPort, env);
  }
  if (env.discord === null) {
    return null;
  }
  const discord = env.discord;
  return new DiscordGateway(gatewayPort, {
    token: discord.token,
    applicationId: discord.applicationId,
    guildIds: discord.guildIds,
    allowedUserIds: discord.allowedUserIds,
    lookupProject: (projectId): { id: string; default_workflow: string; allowed_workflows: string[] } | null => {
      const project = registries.projects.get(projectId);
      return project === null
        ? null
        : {
            id: project.id,
            default_workflow: project.default_workflow,
            allowed_workflows: project.allowed_workflows,
          };
    },
  });
}

function buildGitHubSource(input: {
  gatewayPort: OrchestratorGatewayPortImpl;
  env: OrchestratorEnv;
  overrides: ExternalAdapterOverrides;
  log: (line: string) => void;
}): GitHubIssueTaskSource | null {
  const { gatewayPort, env, overrides, log } = input;
  if (env.github === null && overrides.gitHubOctokit === undefined) {
    return null;
  }
  const octokit = overrides.gitHubOctokit ?? createGitHubClient(env.github?.token ?? '');
  const repos = (env.github?.repos ?? []).map((r) => ({
    projectId: r.projectId,
    owner: r.owner,
    repo: r.repo,
    ...(r.label === undefined ? {} : { label: r.label }),
  }));
  return new GitHubIssueTaskSource({
    octokit,
    repos,
    onTask: async (request: TaskRequest): Promise<void> => {
      await gatewayPort.startTask(request);
    },
    logger: { warn: (m): void => log(`github: ${m}`), error: (m): void => log(`github(error): ${m}`) },
  });
}

function enqueuePlainEvent(
  taskStore: TaskStore,
  taskId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const event: Event = {
    id: randomUUID(),
    task_id: taskId,
    type,
    payload,
    created_at: new Date(),
  };
  return taskStore.enqueueEvent(event).then(() => undefined);
}

/** The agent id the Conductor uses for its meta-LLM calls (first planning agent). */
function conductorAgentId(registries: LoadedRegistries): string {
  // The Conductor is a planning-class meta agent. Prefer a planning-harness
  // agent; fall back to any configured agent so a minimal config still wires.
  for (const project of registries.projects.list()) {
    const workflow = registries.workflows.get(project.default_workflow);
    const planStep = workflow?.steps.find((s) => s.kind === 'write_plan' && s.agent !== null);
    if (planStep?.agent != null) {
      return planStep.agent;
    }
  }
  return 'claude';
}

function matchingRoot(roots: string[], worktreePath: string): string | null {
  return roots.find((root) => worktreePath === root || worktreePath.startsWith(`${root}/`)) ?? null;
}
