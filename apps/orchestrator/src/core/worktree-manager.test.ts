import { describe, expect, it } from 'vitest';

import type { Task } from './types.js';
import { WorktreeManager, type WorktreeFileSystem, type WorktreeGitClient } from './worktree-manager.js';

describe('WorktreeManager', () => {
  it('creates the task worktree through git and bootstraps .forgeroom files', async () => {
    const git = new FakeGitClient();
    const fileSystem = new FakeFileSystem();
    const manager = new WorktreeManager({ git, fileSystem });
    const task = makeTask();

    await expect(manager.create(task)).resolves.toEqual({
      path: '/tmp/forgeroom/worktrees/task-123',
      branch: 'agent/forgeroom-task-123',
    });

    expect(git.createdWorktrees).toEqual([
      {
        path: '/tmp/forgeroom/worktrees/task-123',
        branch: 'agent/forgeroom-task-123',
      },
    ]);
    expect(fileSystem.ensuredDirs).toEqual([
      '/tmp/forgeroom/worktrees/task-123/.forgeroom',
      '/tmp/forgeroom/worktrees/task-123/.forgeroom/context',
      '/tmp/forgeroom/worktrees/task-123/.forgeroom/context/docs',
      '/tmp/forgeroom/worktrees/task-123/.forgeroom/prompts',
      '/tmp/forgeroom/worktrees/task-123/.forgeroom/outputs',
      '/tmp/forgeroom/worktrees/task-123/.forgeroom/diffs',
      '/tmp/forgeroom/worktrees/task-123/.forgeroom/logs',
    ]);
    expect(fileSystem.createdFiles.map((file) => file.path)).toEqual([
      '/tmp/forgeroom/worktrees/task-123/.forgeroom/context/task.md',
      '/tmp/forgeroom/worktrees/task-123/.forgeroom/context/summary.md',
      '/tmp/forgeroom/worktrees/task-123/.forgeroom/context/workflow.md',
      '/tmp/forgeroom/worktrees/task-123/.forgeroom/context/feedback.md',
    ]);
    expect(fileSystem.createdFiles[0]?.content).toContain('# Task');
    expect(fileSystem.createdFiles[0]?.content).toContain('Implement worktree bootstrap');
  });

  it('reuses an existing task worktree and still ensures bootstrap paths', async () => {
    const git = new FakeGitClient();
    const fileSystem = new FakeFileSystem();
    const manager = new WorktreeManager({ git, fileSystem });
    const task = makeTask();

    await manager.create(task);
    await manager.create(task);

    expect(git.createdWorktrees).toHaveLength(1);
    expect(git.existsChecks).toEqual([
      '/tmp/forgeroom/worktrees/task-123',
      '/tmp/forgeroom/worktrees/task-123',
    ]);
    expect(
      fileSystem.ensuredDirs.filter(
        (dir) => dir === '/tmp/forgeroom/worktrees/task-123/.forgeroom/context/docs',
      ),
    ).toHaveLength(2);
    expect(
      fileSystem.createdFiles.filter(
        (file) => file.path === '/tmp/forgeroom/worktrees/task-123/.forgeroom/context/task.md',
      ),
    ).toHaveLength(1);
  });

  it('ensures the .forgeroom directory independently and idempotently', async () => {
    const git = new FakeGitClient();
    const fileSystem = new FakeFileSystem();
    const manager = new WorktreeManager({ git, fileSystem });

    await manager.ensureForgeroomDir('/tmp/forgeroom/worktrees/task-123');
    await manager.ensureForgeroomDir('/tmp/forgeroom/worktrees/task-123/');

    expect(git.createdWorktrees).toEqual([]);
    expect(
      fileSystem.ensuredDirs.filter(
        (dir) => dir === '/tmp/forgeroom/worktrees/task-123/.forgeroom/context/docs',
      ),
    ).toHaveLength(2);
    expect(
      fileSystem.createdFiles.filter(
        (file) => file.path === '/tmp/forgeroom/worktrees/task-123/.forgeroom/context/feedback.md',
      ),
    ).toHaveLength(1);
    expect(
      fileSystem.createdFiles.some(
        (file) => file.path === '/tmp/forgeroom/worktrees/task-123/.forgeroom/context/task.md',
      ),
    ).toBe(false);
  });

  it('fills task metadata after independent bootstrap without overwriting base context files', async () => {
    const git = new FakeGitClient();
    const fileSystem = new FakeFileSystem();
    const manager = new WorktreeManager({ git, fileSystem });
    const task = makeTask();

    await manager.ensureForgeroomDir('/tmp/forgeroom/worktrees/task-123');
    await manager.create(task);

    const taskFile = fileSystem.createdFiles.find(
      (file) => file.path === '/tmp/forgeroom/worktrees/task-123/.forgeroom/context/task.md',
    );
    expect(taskFile?.content).toContain('# Task');
    expect(taskFile?.content).toContain('Implement worktree bootstrap');
    expect(
      fileSystem.createdFiles.filter(
        (file) => file.path === '/tmp/forgeroom/worktrees/task-123/.forgeroom/context/summary.md',
      ),
    ).toHaveLength(1);
  });
});

class FakeGitClient implements WorktreeGitClient {
  readonly createdWorktrees: Array<{ path: string; branch: string }> = [];
  readonly existsChecks: string[] = [];
  private readonly worktreePaths = new Set<string>();

  worktreeExists(worktreePath: string): Promise<boolean> {
    this.existsChecks.push(worktreePath);
    return Promise.resolve(this.worktreePaths.has(worktreePath));
  }

  createWorktree(input: { path: string; branch: string }): Promise<void> {
    this.createdWorktrees.push(input);
    this.worktreePaths.add(input.path);
    return Promise.resolve();
  }
}

class FakeFileSystem implements WorktreeFileSystem {
  readonly ensuredDirs: string[] = [];
  readonly createdFiles: Array<{ path: string; content: string }> = [];
  private readonly filePaths = new Set<string>();

  ensureDir(dirPath: string): Promise<void> {
    this.ensuredDirs.push(dirPath);
    return Promise.resolve();
  }

  writeFileIfMissing(filePath: string, content: string): Promise<void> {
    if (this.filePaths.has(filePath)) {
      return Promise.resolve();
    }

    this.createdFiles.push({ path: filePath, content });
    this.filePaths.add(filePath);
    return Promise.resolve();
  }
}

function makeTask(): Task {
  return {
    id: 'task-123',
    project_id: 'forgeroom',
    workflow_id: 'goal-feature',
    title: 'Implement worktree bootstrap',
    description: 'Create idempotent .forgeroom bootstrap paths.',
    status: 'queued',
    failure_reason: null,
    source: 'discord-command',
    external_ref: null,
    issue_number: null,
    branch_name: 'agent/forgeroom-task-123',
    worktree_path: '/tmp/forgeroom/worktrees/task-123',
    pr_number: null,
    final_slices: [],
    vars: {},
    mastra_run_id: null,
    created_at: new Date('2026-05-22T00:00:00.000Z'),
    updated_at: new Date('2026-05-22T00:00:00.000Z'),
  };
}
