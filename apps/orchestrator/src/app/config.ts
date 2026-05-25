/**
 * Composition-root configuration loading (#30).
 *
 * This module is the SINGLE allowed place that reads `process.env` and the
 * `configs/*.yaml` registry files (src/AGENTS.md: env/config loading is isolated
 * to the composition root). Everything downstream receives validated, typed
 * config via constructor injection — no other module touches `process.env`.
 *
 * The loader builds the registry objects (#7 family) from the yaml documents and
 * resolves the runtime env (DB path, worktree roots, Discord/GitHub/OpenClaw
 * credentials). Missing external credentials are NOT a hard failure: the boot
 * path can compose + recover without starting the credentialed TaskSources
 * (#31 exercises real credentials), so the env shape records what is present and
 * the composition root gates source startup on it.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';

import { AgentRegistry } from '../core/agent-runtime/agent-registry.js';
import { HarnessRegistry } from '../core/agent-runtime/harness-registry.js';
import { IntentRegistry } from '../core/registries/intent-registry.js';
import { ProjectRegistry } from '../core/registries/project-registry.js';
import { WorkflowRegistry } from '../core/registries/workflow-registry.js';

// ---------------------------------------------------------------------------
// Registry bundle
// ---------------------------------------------------------------------------

export interface LoadedRegistries {
  harnesses: HarnessRegistry;
  agents: AgentRegistry;
  intents: IntentRegistry;
  workflows: WorkflowRegistry;
  projects: ProjectRegistry;
  /** Raw workflow yaml documents keyed by file id, for WorkflowSourceProvider. */
  workflowSources: Record<string, string>;
}

export interface LoadRegistriesOptions {
  /** Directory holding the `*.yaml` config files (default: `<repo>/configs`). */
  configDir: string;
  /** Override path existence checks (tests pass a stub). */
  projectPathExists?: (projectPath: string) => boolean;
  /** Override prompt-template existence checks (default: accept all). */
  templateExists?: (relativePath: string) => boolean;
}

const CONFIG_FILES = {
  harnesses: 'harnesses.yaml',
  agents: 'agents.yaml',
  intents: 'intents.yaml',
  workflows: 'workflows.yaml',
  projects: 'projects.yaml',
} as const;

// Each registry's fromConfig takes a `Record<string, RawX>` where RawX is a
// private all-optional-unknown shape; a parsed yaml document satisfies it
// structurally but TS cannot prove the index signature, so we read each doc as
// the loose registry-config shape. Validation happens inside fromConfig.
type RegistryConfig<T> = Record<string, T>;

async function readYamlDoc<T>(file: string): Promise<{ raw: string; doc: RegistryConfig<T> }> {
  const raw = await readFile(file, 'utf8');
  const doc = (parseYaml(raw) ?? {}) as RegistryConfig<T>;
  return { raw, doc };
}

/**
 * Load + validate the registry yaml documents. Validation is delegated to each
 * registry's `fromConfig` (a malformed config throws there, surfacing at boot).
 */
export async function loadRegistries(options: LoadRegistriesOptions): Promise<LoadedRegistries> {
  const dir = options.configDir;
  const [harnessesDoc, agentsDoc, intentsDoc, workflowsDoc, projectsDoc] = await Promise.all([
    readYamlDoc<Parameters<typeof HarnessRegistry.fromConfig>[0][string]>(
      path.join(dir, CONFIG_FILES.harnesses),
    ),
    readYamlDoc<Parameters<typeof AgentRegistry.fromConfig>[0][string]>(path.join(dir, CONFIG_FILES.agents)),
    readYamlDoc<Parameters<typeof IntentRegistry.fromConfig>[0][string]>(
      path.join(dir, CONFIG_FILES.intents),
    ),
    readYamlDoc<Parameters<typeof WorkflowRegistry.fromConfig>[0][string]>(
      path.join(dir, CONFIG_FILES.workflows),
    ),
    readYamlDoc<Parameters<typeof ProjectRegistry.fromConfig>[0][string]>(
      path.join(dir, CONFIG_FILES.projects),
    ),
  ]);

  const harnesses = HarnessRegistry.fromConfig(harnessesDoc.doc);
  const agents = AgentRegistry.fromConfig(agentsDoc.doc, harnesses);
  const intents = IntentRegistry.fromConfig(intentsDoc.doc);
  const workflows = WorkflowRegistry.fromConfig(
    workflowsDoc.doc,
    { intentRegistry: intents, agentRegistry: agents, harnessRegistry: harnesses },
    { templateExists: options.templateExists ?? ((): boolean => true) },
  );
  const projects = ProjectRegistry.fromConfig(projectsDoc.doc, workflows, {
    projectPathExists: options.projectPathExists,
  });

  // Every workflow id resolves to the single workflows.yaml document (the
  // WorkflowSourceProvider re-parses raw yaml; one document defines all ids).
  const workflowSources: Record<string, string> = {};
  for (const workflow of workflows.list()) {
    workflowSources[workflow.id] = workflowsDoc.raw;
  }

  return { harnesses, agents, intents, workflows, projects, workflowSources };
}

// ---------------------------------------------------------------------------
// Runtime environment
// ---------------------------------------------------------------------------

/**
 * Discord TaskSource credentials. Absent → the Discord source is not started
 * (the boot path still composes everything else).
 */
export interface DiscordEnv {
  token: string;
  applicationId: string;
  guildIds: string[];
  allowedUserIds: string[];
}

/** GitHub credentials + the repos the issue poller watches. */
export interface GitHubEnv {
  token: string;
  repos: Array<{ projectId: string; owner: string; repo: string; label?: string }>;
}

/** OpenClaw runtime endpoint (the real subprocess/IPC is wired in #31). */
export interface OpenClawEnv {
  endpoint: string;
  token: string;
  runtime: string;
  /** CLI binary for the subprocess transport (FORGEROOM_OPENCLAW_BIN). */
  cliBin?: string;
  /**
   * Raw `FORGEROOM_OPENCLAW_ARGS` JSON string-array override for the leading
   * argv, or undefined to use the adapter default (`["agent","--json"]`).
   * Parsed by the IPC client so the parse-error surface stays with the adapter
   * that owns the convention.
   */
  cliArgsJson?: string | undefined;
  /** OpenClaw agent id to drive (FORGEROOM_OPENCLAW_AGENT, default `main`). */
  agentId: string;
}

export interface OrchestratorEnv {
  /** SQLite file path; `:memory:` is allowed for tests. */
  dbPath: string;
  /** Roots under which task worktrees may be created (ApprovalGate allowlist). */
  allowedWorktreeRoots: string[];
  /** Directory durable Mastra snapshots are written to (FileSnapshotBridge). */
  snapshotDir: string;
  /** Whether Mastra Studio opt-in is set (production start must be false). */
  studioEnabled: boolean;
  discord: DiscordEnv | null;
  github: GitHubEnv | null;
  openclaw: OpenClawEnv;
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Parse `FORGEROOM_GITHUB_REPOS` of the form
 * `projectId=owner/repo[:label],projectId2=owner2/repo2`.
 */
function parseGitHubRepos(value: string | undefined): GitHubEnv['repos'] {
  const repos: GitHubEnv['repos'] = [];
  for (const entry of splitList(value)) {
    const [projectId, location] = entry.split('=');
    if (projectId === undefined || location === undefined) {
      continue;
    }
    const [ownerRepo, label] = location.split(':');
    const [owner, repo] = (ownerRepo ?? '').split('/');
    if (owner === undefined || repo === undefined || owner === '' || repo === '') {
      continue;
    }
    repos.push({ projectId, owner, repo, ...(label === undefined ? {} : { label }) });
  }
  return repos;
}

/**
 * Resolve the runtime env from the passed record (defaults to `process.env`).
 * Pure function of its input so the boot integration test injects a temp env.
 *
 * Required env vars (documented in app/AGENTS.md):
 *   FORGEROOM_DB_PATH               sqlite path (default data/forgeroom.sqlite)
 *   FORGEROOM_WORKTREE_ROOTS        comma-list of allowed worktree roots (required)
 *   FORGEROOM_SNAPSHOT_DIR          snapshot dir (default <db dir>/snapshots)
 *   FORGEROOM_OPENCLAW_ENDPOINT     OpenClaw endpoint (required)
 *   FORGEROOM_OPENCLAW_TOKEN        OpenClaw token (required)
 *   FORGEROOM_OPENCLAW_RUNTIME      default runtime id (default: claude-cli)
 *   FORGEROOM_OPENCLAW_BIN          OpenClaw CLI binary (default: openclaw)
 *   FORGEROOM_OPENCLAW_ARGS         JSON string-array leading argv (default: ["agent","--json"])
 *   FORGEROOM_OPENCLAW_AGENT        OpenClaw agent id (default: main)
 *   DISCORD_BOT_TOKEN / DISCORD_APPLICATION_ID / DISCORD_GUILD_IDS /
 *     DISCORD_ALLOWED_USER_IDS      Discord source (omit all to skip the source)
 *   GITHUB_TOKEN / FORGEROOM_GITHUB_REPOS   GitHub source (omit to skip)
 *   FORGEROOM_STUDIO                Studio opt-in (production: unset)
 */
export function resolveEnv(env: NodeJS.ProcessEnv = process.env): OrchestratorEnv {
  const dbPath = env.FORGEROOM_DB_PATH ?? 'data/forgeroom.sqlite';
  const worktreeRoots = splitList(env.FORGEROOM_WORKTREE_ROOTS);
  if (worktreeRoots.length === 0) {
    throw new ConfigError('FORGEROOM_WORKTREE_ROOTS is required (comma-separated absolute paths)');
  }
  const snapshotDir =
    env.FORGEROOM_SNAPSHOT_DIR ??
    (dbPath === ':memory:' ? 'data/snapshots' : path.join(path.dirname(dbPath), 'snapshots'));

  const openclawEndpoint = env.FORGEROOM_OPENCLAW_ENDPOINT ?? '';
  const openclawToken = env.FORGEROOM_OPENCLAW_TOKEN ?? '';
  const openclawRuntime = env.FORGEROOM_OPENCLAW_RUNTIME ?? 'claude-cli';
  const openclawCliBin = env.FORGEROOM_OPENCLAW_BIN?.trim() || 'openclaw';
  const openclawCliArgsJson = env.FORGEROOM_OPENCLAW_ARGS;
  const openclawAgentId = env.FORGEROOM_OPENCLAW_AGENT?.trim() || 'main';

  const discord = resolveDiscordEnv(env);
  const github = resolveGitHubEnv(env);

  return {
    dbPath,
    allowedWorktreeRoots: worktreeRoots,
    snapshotDir,
    studioEnabled: TRUTHY.has((env.FORGEROOM_STUDIO ?? '').trim().toLowerCase()),
    discord,
    github,
    openclaw: {
      endpoint: openclawEndpoint,
      token: openclawToken,
      runtime: openclawRuntime,
      cliBin: openclawCliBin,
      cliArgsJson: openclawCliArgsJson,
      agentId: openclawAgentId,
    },
  };
}

function resolveDiscordEnv(env: NodeJS.ProcessEnv): DiscordEnv | null {
  const token = env.DISCORD_BOT_TOKEN ?? '';
  const applicationId = env.DISCORD_APPLICATION_ID ?? '';
  if (token === '' || applicationId === '') {
    return null;
  }
  return {
    token,
    applicationId,
    guildIds: splitList(env.DISCORD_GUILD_IDS),
    allowedUserIds: splitList(env.DISCORD_ALLOWED_USER_IDS),
  };
}

function resolveGitHubEnv(env: NodeJS.ProcessEnv): GitHubEnv | null {
  const token = env.GITHUB_TOKEN ?? '';
  const repos = parseGitHubRepos(env.FORGEROOM_GITHUB_REPOS);
  if (token === '' || repos.length === 0) {
    return null;
  }
  return { token, repos };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
