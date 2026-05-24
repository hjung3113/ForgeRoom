import { describe, expect, it } from 'vitest';

import { GitCli, type GitExecFileFn } from './git-cli.js';

interface ExecCall {
  file: string;
  args: string[];
  options: { cwd?: string };
}

function fakeExecFile(outputs: string[]): { execFileFn: GitExecFileFn; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const execFileFn: GitExecFileFn = (file, args, options, callback) => {
    calls.push({ file, args, options });
    const stdout = outputs.shift() ?? '';
    callback(null, stdout, '');
  };
  return { execFileFn, calls };
}

describe('GitCli', () => {
  it('returns trimmed HEAD commit from rev-parse', async () => {
    const fake = fakeExecFile(['abc123\n']);
    const git = new GitCli({ execFileFn: fake.execFileFn });

    await expect(git.revParseHead('/repo')).resolves.toBe('abc123');

    expect(fake.calls).toEqual([
      {
        file: 'git',
        args: ['rev-parse', 'HEAD'],
        options: { cwd: '/repo' },
      },
    ]);
  });

  it('returns raw porcelain status stdout without trimming', async () => {
    const fake = fakeExecFile([' M file.ts\n']);
    const git = new GitCli({ execFileFn: fake.execFileFn });

    await expect(git.statusPorcelain('/repo')).resolves.toBe(' M file.ts\n');

    expect(fake.calls[0]).toEqual({
      file: 'git',
      args: ['status', '--porcelain'],
      options: { cwd: '/repo' },
    });
  });

  it('checks exact worktree path matches from porcelain worktree list output', async () => {
    const fake = fakeExecFile(['worktree /repo\nHEAD abc\n\nworktree /tmp/wt\nHEAD def\n']);
    const git = new GitCli({ execFileFn: fake.execFileFn });

    await expect(git.worktreeExists({ cwd: '/repo', path: '/tmp/wt' })).resolves.toBe(true);
    await expect(git.worktreeExists({ cwd: '/repo', path: '/tmp/wt-other' })).resolves.toBe(false);

    expect(fake.calls[0]).toEqual({
      file: 'git',
      args: ['worktree', 'list', '--porcelain'],
      options: { cwd: '/repo' },
    });
  });

  it('adds a branch worktree from the requested base', async () => {
    const fake = fakeExecFile(['']);
    const git = new GitCli({ execFileFn: fake.execFileFn });

    await git.worktreeAddBranch({
      cwd: '/repo',
      branch: 'feature/x',
      path: '/tmp/wt',
      base: 'main',
    });

    expect(fake.calls).toEqual([
      {
        file: 'git',
        args: ['worktree', 'add', '-b', 'feature/x', '/tmp/wt', 'main'],
        options: { cwd: '/repo' },
      },
    ]);
  });
});
