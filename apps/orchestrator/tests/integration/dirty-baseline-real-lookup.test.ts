/**
 * #42 — dirty-baseline approval wiring through the REAL TaskStoreContextLookup.
 *
 * The #32 matrix proved the engine/stager flow with a modeled `approvalAwareLookup`.
 * This regression test instead drives the PRODUCTION read-back path end to end:
 *   gateway records `dirty_baseline_approved` (ADR-013) → SqliteTaskStore event →
 *   the real `TaskStoreContextLookup` surfaces `dirtyBaselineApprovedBy` → the real
 *   `ForgeMapStagerImpl` proceeds on a dirty baseline (no ForgeMapStaleError).
 *
 * And the negative: with no approval recorded, the same wiring still blocks.
 */
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { OrchestratorGatewayPortImpl } from '../../src/app/gateway-port.js';
import {
  BootstrapForgeMapStore,
  TaskStoreContextLookup,
} from '../../src/app/forgemap-adapters.js';
import { ForgeMapStagerImpl, ForgeMapStaleError } from '../../src/core/context/forgemap.js';
import { ProjectRegistry } from '../../src/core/registries/project-registry.js';
import { WorkflowRegistry } from '../../src/core/registries/workflow-registry.js';
import { IntentRegistry } from '../../src/core/registries/intent-registry.js';
import { AgentRegistry } from '../../src/core/agent-runtime/agent-registry.js';
import { HarnessRegistry } from '../../src/core/agent-runtime/harness-registry.js';
import type { PipelineEngine } from '../../src/core/engine/pipeline-engine.js';
import type { Conductor } from '../../src/core/types.js';
import {
  createTaskStoreDatabase,
  migrateTaskStoreDatabase,
} from '../../src/db/client.js';
import { SqliteTaskStore } from '../../src/db/sqlite-task-store.js';
import { INTENTS, FakeRepoStateProbe } from './acceptance-harness.js';

interface Fixture {
  store: SqliteTaskStore;
  stager: ForgeMapStagerImpl;
  recordApproval: (taskId: string, approvedBy: string) => Promise<void>;
  worktree: string;
  cleanup: () => Promise<void>;
}

async function makeFixture(): Promise<Fixture> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'dbwire-'));
  const projectPath = path.join(tempDir, 'project');
  const worktree = path.join(tempDir, 'worktree');
  for (const dir of ['.forgeroom', '.forgeroom/context', '.forgeroom/context/docs']) {
    await mkdir(path.join(worktree, dir), { recursive: true });
  }

  const database = createTaskStoreDatabase(path.join(tempDir, 'forgeroom.sqlite'));
  migrateTaskStoreDatabase(database);
  const store = new SqliteTaskStore(database);

  const harnessRegistry = HarnessRegistry.fromConfig({ planning: { source: 'planning' } });
  const agentRegistry = AgentRegistry.fromConfig(
    { claude: { provider: 'openclaw', runtime: 'claude-cli', model: 'anthropic/claude', harness: 'planning' } },
    harnessRegistry,
  );
  const intentRegistry = IntentRegistry.fromConfig(INTENTS);
  const minimalWorkflow = {
    description: 'dbwire workflow',
    effects: { worktree: 'modifies' as const, external: { report: 'status' as const, pr: 'ready' as const } },
    steps: [{ type: 'run' as const, id: 'plan', intent: 'claude_write_plan', prompt_template: 'plan.md' }],
  };
  const workflowRegistry = WorkflowRegistry.fromConfig(
    { hotfix: minimalWorkflow },
    { intentRegistry, agentRegistry, harnessRegistry },
    { templateExists: () => true },
  );
  const projectRegistry = ProjectRegistry.fromConfig(
    {
      forgeroom: {
        path: projectPath,
        default_branch: 'main',
        package_manager: 'pnpm',
        default_workflow: 'hotfix',
        allowed_workflows: ['hotfix'],
        commands: { lint: 'echo lint', typecheck: 'echo tc', test: 'echo test' },
        maintainers: { discord_user_ids: ['111'], github_logins: ['octocat'] },
      },
    },
    workflowRegistry,
    { projectPathExists: () => true },
  );

  // The repo is dirty: without an approval the stager must block.
  const repoProbe = new FakeRepoStateProbe({ commit: 'abc', dirty: true });
  const lookup = new TaskStoreContextLookup({ taskStore: store, workflowRegistry, projectRegistry });
  const stager = new ForgeMapStagerImpl({
    store: new BootstrapForgeMapStore({ projectRegistry, repoProbe }),
    repoProbe,
    taskLookup: lookup,
  });

  // The REAL gateway facade records the approval exactly as the composition root
  // wires it: a `dirty_baseline_approved` TaskStore event carrying { approvedBy }.
  const gatewayPort = new OrchestratorGatewayPortImpl({
    engine: {} as unknown as PipelineEngine,
    conductor: {} as unknown as Conductor,
    taskStore: store,
    recordApprovalEvent: (taskId, approvedBy) =>
      store
        .enqueueEvent({
          id: `${taskId}-approval`,
          task_id: taskId,
          type: 'dirty_baseline_approved',
          payload: { approvedBy },
          created_at: new Date(),
        })
        .then(() => undefined),
    recordFeedbackEvent: () => Promise.resolve(),
  });

  const cleanup = async (): Promise<void> => {
    database.close();
    await rm(tempDir, { recursive: true, force: true });
  };

  return { store, stager, recordApproval: (id, by) => gatewayPort.recordApproval(id, by), worktree, cleanup };
}

async function seedTask(store: SqliteTaskStore, taskId: string, worktree: string): Promise<void> {
  await store.startTask({
    id: taskId,
    project_id: 'forgeroom',
    workflow_id: 'hotfix',
    title: 'dirty task',
    description: 'd',
    status: 'running',
    source: 'discord-command',
    external_ref: null,
    issue_number: null,
    branch_name: `forge/${taskId}`,
    worktree_path: worktree,
    pr_number: null,
    final_slices: [],
    vars: {},
    mastra_run_id: null,
  });
}

let fixture: Fixture;

afterEach(async () => {
  await fixture.cleanup();
});

describe('#42 — real TaskStoreContextLookup dirty-baseline read-back', () => {
  it('proceeds once the gateway records a dirty-baseline approval', async () => {
    fixture = await makeFixture();
    const taskId = 'task-approved';
    await seedTask(fixture.store, taskId, fixture.worktree);

    // ADR-013: maintainer approves via the originating channel → TaskStore event.
    await fixture.recordApproval(taskId, 'maintainer-octocat');

    // The real lookup reads the recorded approval, so staging proceeds.
    await expect(
      fixture.stager.stage({ taskId, worktreePath: fixture.worktree, projectId: 'forgeroom' }),
    ).resolves.toBeUndefined();

    const manifest = await readFile(
      path.join(fixture.worktree, '.forgeroom', 'context', 'selected-forgemap.md'),
      'utf8',
    );
    expect(manifest).toMatch(/dirty baseline: maintainer maintainer-octocat approved/);
  });

  it('still blocks a dirty baseline when no approval was recorded', async () => {
    fixture = await makeFixture();
    const taskId = 'task-unapproved';
    await seedTask(fixture.store, taskId, fixture.worktree);

    await expect(
      fixture.stager.stage({ taskId, worktreePath: fixture.worktree, projectId: 'forgeroom' }),
    ).rejects.toBeInstanceOf(ForgeMapStaleError);
  });
});
