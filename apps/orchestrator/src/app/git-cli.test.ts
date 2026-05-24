import { describe, expect, it } from 'vitest';

import { GitCli, type GitExecFileFn } from './git-cli.js';

interface ExecCall {
  file: string;
  args: string[];
  options: { cwd?: string };
}

type ExecResult = string | Error;

function fakeExecFile(outputs: ExecResult[]): { execFileFn: GitExecFileFn; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const execFileFn: GitExecFileFn = (file, args, options, callback) => {
    calls.push({ file, args, options });
    const next = outputs.shift() ?? '';
    if (next instanceof Error) {
      callback(next as NodeJS.ErrnoException, '', '');
      return;
    }
    const stdout = next;
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

  it('returns porcelain -z paths and skips rename origin records', async () => {
    const fake = fakeExecFile([' M changed.ts\0R  renamed.ts\0old.ts\0?? new.ts\0']);
    const git = new GitCli({ execFileFn: fake.execFileFn });

    await expect(git.statusPorcelainZPaths('/repo')).resolves.toEqual([
      'changed.ts',
      'renamed.ts',
      'new.ts',
    ]);

    expect(fake.calls).toEqual([
      {
        file: 'git',
        args: ['status', '--porcelain', '--untracked-files=all', '-z'],
        options: { cwd: '/repo' },
      },
    ]);
  });

  it('restores paths from HEAD and lets restore errors throw', async () => {
    const fake = fakeExecFile(['', new Error('restore failed')]);
    const git = new GitCli({ execFileFn: fake.execFileFn });

    await expect(git.restoreFromHead({ cwd: '/repo', paths: ['a.ts', 'b.ts'] })).resolves.toBeUndefined();
    await expect(git.restoreFromHead({ cwd: '/repo', paths: ['missing.ts'] })).rejects.toThrow('restore failed');

    expect(fake.calls[0]).toEqual({
      file: 'git',
      args: ['restore', '--source=HEAD', '--worktree', '--', 'a.ts', 'b.ts'],
      options: { cwd: '/repo' },
    });
  });

  it('maps ls-files success and failure to tracked booleans', async () => {
    const fake = fakeExecFile(['tracked.ts', new Error('not tracked')]);
    const git = new GitCli({ execFileFn: fake.execFileFn });

    await expect(git.isTracked({ cwd: '/repo', rel: 'tracked.ts' })).resolves.toBe(true);
    await expect(git.isTracked({ cwd: '/repo', rel: 'untracked.ts' })).resolves.toBe(false);

    expect(fake.calls[0]).toEqual({
      file: 'git',
      args: ['ls-files', '--error-unmatch', '--', 'tracked.ts'],
      options: { cwd: '/repo' },
    });
  });
});
