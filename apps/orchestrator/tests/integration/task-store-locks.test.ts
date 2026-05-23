import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { OrchestratorFailureCode } from '../../src/core/errors.js';
import type { TaskStore } from '../../src/core/task-store.js';
import {
  createTaskStoreDatabase,
  migrateTaskStoreDatabase,
  type TaskStoreDatabase,
} from '../../src/db/client.js';
import { SqliteTaskStore } from '../../src/db/sqlite-task-store.js';

describe('TaskStore lock integration', () => {
  let tempDir: string;
  let database: TaskStoreDatabase;
  let store: TaskStore;

  beforeEach(() => {
    // Use a real on-disk SQLite file (not :memory:) per testing-rules so lock
    // behavior is exercised against actual file-backed constraints and WAL.
    tempDir = mkdtempSync(join(tmpdir(), 'forgeroom-locks-'));
    database = createTaskStoreDatabase(join(tempDir, 'forgeroom.sqlite'));
    migrateTaskStoreDatabase(database);
    store = new SqliteTaskStore(database);
  });

  afterEach(() => {
    database.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('keeps one active task per project and releases the lock on cancel', async () => {
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

  it('round-trips mastra_run_id (ADR-017): null default, set, and clear', async () => {
    await store.startTask(taskInput('task-mastra', 'project-b'));

    await expect(store.getMastraRunId('task-mastra')).resolves.toBeNull();
    await expect(store.getTask('task-mastra')).resolves.toMatchObject({ mastra_run_id: null });

    await store.setMastraRunId('task-mastra', 'mastra-run-xyz');
    await expect(store.getMastraRunId('task-mastra')).resolves.toBe('mastra-run-xyz');

    // Survives reopening the file-backed database.
    database.close();
    database = createTaskStoreDatabase(join(tempDir, 'forgeroom.sqlite'));
    migrateTaskStoreDatabase(database);
    store = new SqliteTaskStore(database);
    await expect(store.getMastraRunId('task-mastra')).resolves.toBe('mastra-run-xyz');

    await store.setMastraRunId('task-mastra', null);
    await expect(store.getMastraRunId('task-mastra')).resolves.toBeNull();
  });

  it('rejects non-canonical failure_reason values', async () => {
    await store.startTask(taskInput('task-failure', 'project-c'));

    await expect(
      store.updateTaskStatus(
        'task-failure',
        'failed',
        'not_a_real_reason' as unknown as OrchestratorFailureCode,
      ),
    ).rejects.toThrow(/invalid failure_reason/i);

    await store.updateTaskStatus('task-failure', 'failed', 'check_failed_after_fix');
    await expect(store.getTask('task-failure')).resolves.toMatchObject({
      status: 'failed',
      failure_reason: 'check_failed_after_fix',
    });
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
    final_slices: [],
    vars: {},
  };
}
