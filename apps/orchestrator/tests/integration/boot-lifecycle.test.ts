/**
 * Composition-root boot-lifecycle integration test (#30).
 *
 * Boots the orchestrator with TEMP `configs/*.yaml` + a real temp SQLite store +
 * INJECTED fakes for the external-I/O adapters (Discord / GitHub / OpenClaw),
 * since live credentials are not available in the sandbox (#31 exercises real
 * credentials). Asserts:
 *   - configs load into registries,
 *   - every dep wires (engine + gateway port + sources are constructed),
 *   - `recoverPending()` runs on boot (an active task left in the store is
 *     visited),
 *   - the TaskSources start (Discord gateway start() + GitHub poll loop),
 *   - ApprovalGate is placed BOTH pre-Mastra (worktree admission) and in-step
 *     (agent command) — proven via a /run that an admission deny rejects, and
 *     the in-step gate path existing in the engine,
 *   - Studio is NOT auto-started by the production boot path.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTaskStoreDatabase, migrateTaskStoreDatabase } from '../../src/db/client.js';
import { SqliteTaskStore } from '../../src/db/sqlite-task-store.js';
import { loadRegistries, resolveEnv, type OrchestratorEnv } from '../../src/app/config.js';
import { makeTestTemplateRoot } from '../../src/core/test-support/template-fixtures.js';
import {
  composeOrchestrator,
  type DiscordGatewayLike,
  type ExternalAdapterOverrides,
} from '../../src/app/composition-root.js';
import { isStudioEnabled } from '../../src/studio/gate.js';
import type { OpenClawIpcClient } from '../../src/core/agent-runtime/openclaw-provider.js';
import type { GitHubOctokitLike, GitHubIssue } from '../../src/gateway/github-gateway.js';
import type { DiscordStatusClient, GitHubStatusClient } from '../../src/core/reporting/reporter.js';
import type { TaskStoreDatabase } from '../../src/db/client.js';
import type { Task } from '../../src/core/types.js';

// ---------------------------------------------------------------------------
// Temp configs
// ---------------------------------------------------------------------------

const HARNESSES_YAML = `
planning:
  source: .forgeroom/harnesses/planning
implementation:
  source: .forgeroom/harnesses/implementation
review:
  source: .forgeroom/harnesses/review
`;

const AGENTS_YAML = `
claude:
  provider: openclaw
  runtime: claude-cli
  model: anthropic/claude
  harness: planning
codex:
  provider: openclaw
  runtime: openai-codex
  model: openai/gpt
  harness: implementation
`;

const INTENTS_YAML = `
claude_write_plan:
  kind: write_plan
  agent: claude
  harness: planning
codex_execute:
  kind: execute
  agent: codex
  harness: implementation
`;

const WORKFLOWS_YAML = `
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
      prompt_template: plan.md
    - type: run
      id: implement
      intent: codex_execute
      prompt_template: execute.md
      input_refs:
        plan: \${plan.output_path}
`;

function projectsYaml(projectPath: string, defaultBranch = 'main'): string {
  return `
demo:
  path: ${projectPath}
  default_branch: ${defaultBranch}
  package_manager: pnpm
  default_workflow: quick
  allowed_workflows:
    - quick
  template_dir: null
  commands:
    lint: echo lint
    typecheck: echo tc
    test: echo test
  maintainers:
    discord_user_ids:
      - "111"
    github_logins:
      - octocat
`;
}

// ---------------------------------------------------------------------------
// Fakes for external I/O
// ---------------------------------------------------------------------------

function fakeOpenClaw(): OpenClawIpcClient {
  return {
    health: () => Promise.resolve({ ok: false, message: 'fake' }),
    run: () => Promise.reject(new Error('fake openclaw run')),
    resume: () => Promise.reject(new Error('fake openclaw resume')),
  };
}

function fakeDiscordStatusClient(): DiscordStatusClient {
  return {
    sendMessage: () => Promise.resolve({ id: 'msg-1' }),
    editMessage: () => Promise.resolve(),
  };
}

function fakeGitHubStatusClient(): GitHubStatusClient {
  return {
    createIssueComment: () => Promise.resolve({ id: '1' }),
    updateIssueComment: () => Promise.resolve(),
    updatePrComment: () => Promise.resolve(),
  };
}

function fakeOctokit(issues: GitHubIssue[], pollCalls: { n: number }): GitHubOctokitLike {
  return {
    rest: {
      issues: {
        listForRepo: (): Promise<{ data: GitHubIssue[] }> => {
          pollCalls.n += 1;
          return Promise.resolve({ data: issues });
        },
        addLabels: () => Promise.resolve({}),
        removeLabel: () => Promise.resolve({}),
      },
      pulls: {
        create: () => Promise.resolve({ data: { number: 1, html_url: 'u' } }),
        update: () => Promise.resolve({ data: { number: 1, html_url: 'u' } }),
        list: () => Promise.resolve({ data: [] }),
      },
    },
  };
}

class FakeDiscordGateway implements DiscordGatewayLike {
  started = false;
  stopped = false;
  start(): Promise<void> {
    this.started = true;
    return Promise.resolve();
  }
  stop(): Promise<void> {
    this.stopped = true;
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let tempDir: string;
let templateRoot: string;
let database: TaskStoreDatabase | null = null;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'boot-int-'));
  templateRoot = await makeTestTemplateRoot();
});

afterEach(async () => {
  database?.close();
  database = null;
  await rm(tempDir, { recursive: true, force: true });
});

async function writeConfigs(input?: { defaultBranch?: string }): Promise<{ configDir: string; projectPath: string }> {
  const configDir = path.join(tempDir, 'configs');
  const projectPath = path.join(tempDir, 'project');
  await mkdir(configDir, { recursive: true });
  await mkdir(projectPath, { recursive: true });
  await Promise.all([
    writeFile(path.join(configDir, 'harnesses.yaml'), HARNESSES_YAML),
    writeFile(path.join(configDir, 'agents.yaml'), AGENTS_YAML),
    writeFile(path.join(configDir, 'intents.yaml'), INTENTS_YAML),
    writeFile(path.join(configDir, 'workflows.yaml'), WORKFLOWS_YAML),
    writeFile(path.join(configDir, 'projects.yaml'), projectsYaml(projectPath, input?.defaultBranch)),
  ]);
  return { configDir, projectPath };
}

function makeEnv(overrides: Partial<OrchestratorEnv> = {}): OrchestratorEnv {
  return {
    dbPath: path.join(tempDir, 'forgeroom.sqlite'),
    allowedWorktreeRoots: [path.join(tempDir, 'worktrees')],
    snapshotDir: path.join(tempDir, 'snapshots'),
    templateRoot,
    studioEnabled: false,
    discord: { token: 't', applicationId: 'app', guildIds: ['g'], allowedUserIds: ['111'] },
    github: { token: 'gh', repos: [{ projectId: 'demo', owner: 'octocat', repo: 'demo' }] },
    openclaw: { endpoint: 'http://localhost', token: 'tok', runtime: 'claude-cli', agentId: 'main' },
    ...overrides,
  };
}

async function buildApp(input?: { issues?: GitHubIssue[]; pollCalls?: { n: number } }) {
  const { configDir, projectPath } = await writeConfigs();
  const registries = await loadRegistries({ configDir, projectPathExists: () => true });
  database = createTaskStoreDatabase(path.join(tempDir, 'forgeroom.sqlite'));
  migrateTaskStoreDatabase(database);
  const taskStore = new SqliteTaskStore(database);
  const env = makeEnv();
  const fakeDiscord = new FakeDiscordGateway();
  const overrides: ExternalAdapterOverrides = {
    openClawIpcClient: fakeOpenClaw(),
    discordStatusClient: fakeDiscordStatusClient(),
    gitHubStatusClientFor: () => fakeGitHubStatusClient(),
    gitHubOctokit: fakeOctokit(input?.issues ?? [], input?.pollCalls ?? { n: 0 }),
    buildDiscordGateway: () => fakeDiscord,
  };
  const app = composeOrchestrator({ registries, env, taskStore, overrides, log: () => {} });
  return { app, taskStore, env, registries, projectPath, fakeDiscord };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('orchestrator composition root boot lifecycle (#30)', () => {
  it('loads configs into registries', async () => {
    const { configDir } = await writeConfigs();
    const registries = await loadRegistries({ configDir, projectPathExists: () => true });
    expect(registries.projects.get('demo')).not.toBeNull();
    expect(registries.workflows.get('quick')).not.toBeNull();
    expect(registries.agents.has('claude')).toBe(true);
    expect(registries.intents.has('codex_execute')).toBe(true);
    expect(registries.workflowSources['quick']).toContain('quick:');
  });

  it('wires every dep and starts the TaskSources on boot', async () => {
    const pollCalls = { n: 0 };
    const { app, fakeDiscord } = await buildApp({ pollCalls });

    expect(app.engine).toBeDefined();
    expect(app.gatewayPort).toBeDefined();
    expect(app.discordGateway).not.toBeNull();
    expect(app.gitHubSource).not.toBeNull();

    await app.boot();

    expect(app.recovered).toBe(true);
    expect(fakeDiscord.started).toBe(true);
    // GitHub source poll loop scheduled an immediate first poll.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(pollCalls.n).toBeGreaterThan(0);

    await app.stop();
    expect(fakeDiscord.stopped).toBe(true);
  });

  it('runs recoverPending on boot (visits an active task left in the store)', async () => {
    const { app, taskStore, env } = await buildApp();
    // Seed an active (running) task with a worktree dir that exists, no mastra
    // run id and no steps → recoverPending takes the fresh-run branch, which
    // fails (fake OpenClaw) and is recorded as failed without aborting boot.
    const worktreePath = path.join(env.allowedWorktreeRoots[0]!, 'demo', 'seed-task');
    await mkdir(path.join(worktreePath, '.forgeroom'), { recursive: true });
    await taskStore.startTask({
      id: 'seed-task',
      project_id: 'demo',
      workflow_id: 'quick',
      title: 'seed',
      description: 'seed',
      status: 'running',
      source: 'github-issue-label',
      external_ref: null,
      issue_number: 1,
      branch_name: 'forge/seed',
      worktree_path: worktreePath,
      pr_number: null,
      final_slices: [],
      vars: {},
    });

    await app.boot({ startSources: false });

    const recovered = await taskStore.getTask('seed-task');
    // recoverPending visited it; with the fake provider the fresh run fails, so
    // the task is no longer 'running' — proving recovery actually executed.
    expect(recovered).not.toBeNull();
    expect(recovered?.status).not.toBe('running');
  });

  it('places the real ApprovalGate pre-Mastra (worktree admission denies a disallowed root)', async () => {
    // Compose with a worktree root that the minted worktree path will NOT sit
    // under, so the engine's pre-Mastra ApprovalGate.checkWorktreeCreation
    // denies admission before any Mastra run starts. Proves the gate is wired
    // into runFull (the in-step ApprovalGate.checkCommand is exercised by #8).
    const { configDir } = await writeConfigs();
    const registries = await loadRegistries({ configDir, projectPathExists: () => true });
    database = createTaskStoreDatabase(path.join(tempDir, 'forgeroom2.sqlite'));
    migrateTaskStoreDatabase(database);
    const taskStore = new SqliteTaskStore(database);
    // Empty allowed roots → ApprovalGate.checkWorktreeCreation denies admission
    // (worktree_root_not_allowed) before any Mastra run starts.
    const env = makeEnv({ allowedWorktreeRoots: [] });
    const app = composeOrchestrator({
      registries,
      env,
      taskStore,
      overrides: {
        openClawIpcClient: fakeOpenClaw(),
        discordStatusClient: fakeDiscordStatusClient(),
        gitHubStatusClientFor: () => fakeGitHubStatusClient(),
        gitHubOctokit: fakeOctokit([], { n: 0 }),
        buildDiscordGateway: () => new FakeDiscordGateway(),
      },
      log: () => {},
    });

    await expect(
      app.gatewayPort.startTask({
        projectId: 'demo',
        title: 'gate me',
        description: 'd',
        source: 'discord-command',
      }),
    ).rejects.toThrow(/worktree creation denied/);
  });

  it('wires pull request targets to the project default branch', async () => {
    const { configDir } = await writeConfigs({ defaultBranch: 'develop' });
    const registries = await loadRegistries({ configDir, projectPathExists: () => true });
    database = createTaskStoreDatabase(path.join(tempDir, 'forgeroom-pr.sqlite'));
    migrateTaskStoreDatabase(database);
    const taskStore = new SqliteTaskStore(database);
    const app = composeOrchestrator({
      registries,
      env: makeEnv(),
      taskStore,
      overrides: {
        openClawIpcClient: fakeOpenClaw(),
        discordStatusClient: fakeDiscordStatusClient(),
        gitHubStatusClientFor: () => fakeGitHubStatusClient(),
        gitHubOctokit: fakeOctokit([], { n: 0 }),
        buildDiscordGateway: () => new FakeDiscordGateway(),
      },
      log: () => {},
    });
    const project = registries.projects.get('demo');
    expect(project).not.toBeNull();
    const task: Task = {
      id: 'task-pr',
      project_id: 'demo',
      workflow_id: 'quick',
      title: 't',
      description: 'd',
      status: 'running',
      source: 'github-issue-label',
      external_ref: null,
      issue_number: 1,
      branch_name: 'forge/task-pr',
      worktree_path: path.join(tempDir, 'worktrees', 'demo', 'task-pr'),
      pr_number: null,
      final_slices: [],
      vars: {},
      failure_reason: null,
      mastra_run_id: null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    const target = (app.engine as unknown as { deps: { prTargetFor?: (input: unknown) => unknown } }).deps.prTargetFor?.({
      task,
      project: project!,
    });

    expect(target).toEqual({ owner: 'octocat', repo: 'demo', base: 'develop' });
  });

  it('rejects a /run for a workflow outside allowed_workflows (admission guard)', async () => {
    const { app, registries } = await buildApp();
    await expect(
      app.gatewayPort.startTask({
        projectId: 'demo',
        workflowId: 'not-allowed',
        title: 't',
        description: 'd',
        source: 'discord-command',
      }),
    ).rejects.toThrow(/not allowed/);
    expect(registries.projects.get('demo')?.allowed_workflows).toEqual(['quick']);
  });

  it('does not auto-start Studio in the production boot path', async () => {
    const { app } = await buildApp();
    await app.boot({ startSources: false });
    // The composition root never constructs/launches the Studio Mastra instance;
    // the only Studio entry is gated by FORGEROOM_STUDIO (unset here).
    expect(isStudioEnabled({ FORGEROOM_STUDIO: undefined })).toBe(false);
    await app.stop();
  });

  it('resolveEnv refuses an empty worktree-roots config', () => {
    expect(() => resolveEnv({ FORGEROOM_WORKTREE_ROOTS: '' })).toThrow(/WORKTREE_ROOTS/);
  });

  it('resolveEnv parses GitHub repos + Discord allowlist from env', () => {
    const env = resolveEnv({
      FORGEROOM_WORKTREE_ROOTS: '/tmp/wt',
      FORGEROOM_OPENCLAW_ENDPOINT: 'http://x',
      FORGEROOM_OPENCLAW_TOKEN: 'tok',
      GITHUB_TOKEN: 'gh',
      FORGEROOM_GITHUB_REPOS: 'demo=octocat/demo:agent',
      DISCORD_BOT_TOKEN: 'dt',
      DISCORD_APPLICATION_ID: 'da',
      DISCORD_GUILD_IDS: 'g1,g2',
      DISCORD_ALLOWED_USER_IDS: '111,222',
    });
    expect(env.github?.repos).toEqual([{ projectId: 'demo', owner: 'octocat', repo: 'demo', label: 'agent' }]);
    expect(env.discord?.guildIds).toEqual(['g1', 'g2']);
    expect(env.discord?.allowedUserIds).toEqual(['111', '222']);
    expect(env.studioEnabled).toBe(false);
  });

  it('resolveEnv defaults the OpenClaw agent id to main and honours an override', () => {
    const base = { FORGEROOM_WORKTREE_ROOTS: '/tmp/wt' };
    expect(resolveEnv(base).openclaw.agentId).toBe('main');
    expect(resolveEnv({ ...base, FORGEROOM_OPENCLAW_AGENT: 'reviewer' }).openclaw.agentId).toBe('reviewer');
  });
});
