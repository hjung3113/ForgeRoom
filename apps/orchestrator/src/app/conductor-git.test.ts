import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GitCliConductorGit } from './conductor-git.js';

class FakeGit {
  restoreCalls: Array<{ cwd: string; paths: string[] }> = [];
  isTrackedCalls: Array<{ cwd: string; rel: string }> = [];
  constructor(private readonly tracked: boolean[]) {}

  statusPorcelainZPaths(_cwd: string): Promise<string[]> {
    return Promise.resolve(['changed.ts']);
  }

  restoreFromHead(input: { cwd: string; paths: string[] }): Promise<void> {
    this.restoreCalls.push(input);
    return Promise.reject(new Error('restore rejected'));
  }

  isTracked(input: { cwd: string; rel: string }): Promise<boolean> {
    this.isTrackedCalls.push(input);
    return Promise.resolve(this.tracked.shift() ?? false);
  }
}

let worktree: string;

beforeEach(async () => {
  worktree = await mkdtemp(path.join(tmpdir(), 'conductor-git-'));
});

afterEach(async () => {
  await rm(worktree, { recursive: true, force: true });
});

describe('GitCliConductorGit', () => {
  it('delegates status to GitCli porcelain path parsing', async () => {
    const git = new FakeGit([]);
    const conductorGit = new GitCliConductorGit({ git });

    await expect(conductorGit.status(worktree)).resolves.toEqual(['changed.ts']);
  });

  it('swallows restore errors and deletes untracked paths', async () => {
    await writeFile(path.join(worktree, 'scratch.txt'), 'untracked');
    const git = new FakeGit([false]);
    const conductorGit = new GitCliConductorGit({ git });

    await conductorGit.revert(worktree, ['scratch.txt']);

    expect(git.restoreCalls).toEqual([{ cwd: worktree, paths: ['scratch.txt'] }]);
    await expect(readFile(path.join(worktree, 'scratch.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not delete paths that Git still tracks after restore fails', async () => {
    await writeFile(path.join(worktree, 'tracked.txt'), 'tracked content');
    const git = new FakeGit([true]);
    const conductorGit = new GitCliConductorGit({ git });

    await conductorGit.revert(worktree, ['tracked.txt']);

    expect(git.isTrackedCalls).toEqual([{ cwd: worktree, rel: 'tracked.txt' }]);
    await expect(readFile(path.join(worktree, 'tracked.txt'), 'utf8')).resolves.toBe('tracked content');
  });
});
