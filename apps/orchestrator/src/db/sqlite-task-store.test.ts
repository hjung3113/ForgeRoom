import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TaskStore } from '../core/task-store';
import { createTaskStoreDatabase, migrateTaskStoreDatabase, type TaskStoreDatabase } from './client';
import { SqliteTaskStore } from './sqlite-task-store';

describe('SqliteTaskStore', () => {
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

  it('migrates the tasks table and preserves task JSON fields', async () => {
    const task = await store.createTask({
      id: 'task-json',
      project_id: 'project-a',
      workflow_id: 'workflow-main',
      title: 'Implement JSON preservation',
      description: 'Persist external references and vars.',
      status: 'queued',
      source: 'discord-command',
      external_ref: {
        provider: 'discord',
        id: 'message-1',
        url: 'https://example.test/message-1',
        title: 'Original title',
        status_comment_id: 'comment-1',
        status_message_id: 'status-1',
      },
      issue_number: null,
      branch_name: 'forgeroom/task-json',
      worktree_path: '/tmp/forgeroom/task-json',
      pr_number: null,
      vars: {
        priority: 'high',
        requester: 'hyojung',
      },
    });

    const table = database.sqlite
      .prepare("select name from sqlite_master where type = 'table' and name = 'tasks'")
      .get();
    expect(table).toEqual({ name: 'tasks' });
    expect(
      database.sqlite
        .prepare("select name from forgeroom_migrations where name = '0001_initial.sql'")
        .get(),
    ).toEqual({ name: '0001_initial.sql' });

    await expect(store.getTask(task.id)).resolves.toMatchObject({
      id: 'task-json',
      external_ref: {
        provider: 'discord',
        id: 'message-1',
        url: 'https://example.test/message-1',
        title: 'Original title',
        status_comment_id: 'comment-1',
        status_message_id: 'status-1',
      },
      vars: {
        priority: 'high',
        requester: 'hyojung',
      },
    });
  });

  it('enforces at most one active task per project while allowing queued and done tasks', async () => {
    await store.createTask(taskInput('queued-1', 'project-a', 'queued'));
    await store.createTask(taskInput('done-1', 'project-a', 'done'));
    await store.createTask(taskInput('running-1', 'project-a', 'running'));

    await expect(store.createTask(taskInput('paused-1', 'project-a', 'paused'))).rejects.toThrow(
      /active task/i,
    );

    await expect(
      store.createTask(taskInput('running-other-project', 'project-b', 'running')),
    ).resolves.toMatchObject({
      id: 'running-other-project',
      project_id: 'project-b',
    });
  });

  it('acquires a project lock only when no other active task exists', async () => {
    await store.createTask(taskInput('queued-1', 'project-a', 'queued'));
    await store.createTask(taskInput('queued-2', 'project-a', 'queued'));

    await expect(store.acquireProjectLock('project-a', 'queued-1')).resolves.toBe(true);
    await expect(store.acquireProjectLock('project-a', 'queued-2')).resolves.toBe(false);

    await store.updateTaskStatus('queued-1', 'done');
    await expect(store.acquireProjectLock('project-a', 'queued-2')).resolves.toBe(true);
  });
});

function taskInput(id: string, projectId: string, status: 'queued' | 'running' | 'paused' | 'done') {
  return {
    id,
    project_id: projectId,
    workflow_id: 'workflow-main',
    title: `Task ${id}`,
    description: `Description for ${id}`,
    status,
    source: 'discord-command' as const,
    external_ref: null,
    issue_number: null,
    branch_name: `forgeroom/${id}`,
    worktree_path: `/tmp/forgeroom/${id}`,
    pr_number: null,
    vars: {},
  };
}
