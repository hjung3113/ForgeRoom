import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TaskStore } from '../../apps/orchestrator/src/core/task-store';
import {
  createTaskStoreDatabase,
  migrateTaskStoreDatabase,
  type TaskStoreDatabase,
} from '../../apps/orchestrator/src/db/client';
import { SqliteTaskStore } from '../../apps/orchestrator/src/db/sqlite-task-store';

describe('TaskStore lock integration', () => {
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

  it('uses SQLite constraints to keep one active task per project and releases the lock on cancel', async () => {
    await store.startTask(taskInput('task-active', 'project-a'));

    await expect(store.startTask(taskInput('task-conflict', 'project-a'))).rejects.toThrow(
      /active task/i,
    );
    await expect(store.getTask('task-conflict')).resolves.toBeNull();

    await store.createTask(taskInput('task-next', 'project-a'));
    await store.cancelTask('task-active', 'event-cancel-active', { reason: 'integration' });

    await expect(store.acquireProjectLock('project-a', 'task-next')).resolves.toBe(true);
    await expect(store.listActiveTasks('project-a')).resolves.toMatchObject([
      {
        id: 'task-next',
        status: 'running',
      },
    ]);
  });
});

function taskInput(id: string, projectId: string) {
  return {
    id,
    project_id: projectId,
    workflow_id: 'workflow-main',
    title: `Task ${id}`,
    description: `Description for ${id}`,
    status: 'queued' as const,
    source: 'discord-command' as const,
    external_ref: null,
    issue_number: null,
    branch_name: `forgeroom/${id}`,
    worktree_path: `/tmp/forgeroom/${id}`,
    pr_number: null,
    vars: {},
  };
}
