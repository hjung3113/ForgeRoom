import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentRunRequest, AgentRunResult, AgentRunner, AgentRunnerResumeRequest } from '../../apps/orchestrator/src/core/agent-runner';
import { DefaultPipelineEngine } from '../../apps/orchestrator/src/core/pipeline-engine';
import type { PipelineArtifactStore } from '../../apps/orchestrator/src/core/pipeline-executor';
import type { TaskStore } from '../../apps/orchestrator/src/core/task-store';
import type { Task } from '../../apps/orchestrator/src/core/types';
import type { WorktreeHandle } from '../../apps/orchestrator/src/core/worktree-manager';
import { createTaskStoreDatabase, migrateTaskStoreDatabase, type TaskStoreDatabase } from '../../apps/orchestrator/src/db/client';
import { SqliteTaskStore } from '../../apps/orchestrator/src/db/sqlite-task-store';

describe('PipelineEngine integration', () => {
  let database: TaskStoreDatabase;
  let store: TaskStore;

  beforeEach(() => {
    database = createTaskStoreDatabase(':memory:');
    migrateTaskStoreDatabase(database);
    store = new SqliteTaskStore(database);
  });

  afterEach(() => {
    database.close();
  });

  it('cancel releases the project lock so a queued task for the same project can proceed', async () => {
    const engine = new DefaultPipelineEngine({
      projectRegistry: { get: () => null },
      workflowRegistry: { get: () => null },
      taskStore: store,
      worktreeManager: new FakeWorktreeManager(),
      agentRunner: new FakeAgentRunner(),
      artifactStore: new FakeArtifactStore(),
      createId: fixedIds(['event-cancel']),
    });
    await store.createTask(taskInput('active-task', 'project-a', 'running'));
    await store.createTask(taskInput('queued-task', 'project-a', 'queued'));

    await engine.cancel('active-task');

    await expect(store.acquireProjectLock('project-a', 'queued-task')).resolves.toBe(true);
  });
});

function taskInput(id: string, projectId: string, status: Task['status']) {
  return {
    id,
    project_id: projectId,
    workflow_id: 'feature',
    title: `Task ${id}`,
    description: `Description for ${id}`,
    status,
    source: 'discord-command' as const,
    external_ref: null,
    issue_number: null,
    branch_name: `forgeroom/${id}`,
    worktree_path: `/tmp/forgeroom/${id}`,
    pr_number: null,
    final_slices: [],
    vars: {},
  };
}

class FakeWorktreeManager {
  create(task: Task): Promise<WorktreeHandle> {
    return Promise.resolve({ path: task.worktree_path, branch: task.branch_name });
  }
}

class FakeAgentRunner implements AgentRunner {
  run(req: AgentRunRequest): Promise<AgentRunResult> {
    return Promise.resolve({
      exitCode: 0,
      outputExists: true,
      outputBytes: 100,
      durationMs: 10,
      sessionId: 'session',
      stdoutPath: req.stdoutPath,
      stderrPath: req.stderrPath,
    });
  }

  resume(_req: AgentRunnerResumeRequest): Promise<AgentRunResult> {
    throw new Error('Unexpected resume');
  }
}

class FakeArtifactStore implements PipelineArtifactStore {
  readPromptTemplate(_relativePath: string): Promise<string> {
    return Promise.resolve('');
  }

  readFile(_path: string): Promise<string> {
    return Promise.resolve('');
  }

  writeFile(_path: string, _content: string): Promise<void> {
    return Promise.resolve();
  }
}

function fixedIds(ids: string[]): () => string {
  return () => ids.shift() ?? 'unused-id';
}
