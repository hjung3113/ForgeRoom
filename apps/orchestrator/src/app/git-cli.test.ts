import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GitCli, type GitExecFileFn } from './git-cli.js';

const run = promisify(execFile);

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

describe('GitCli.excludeFromWorktree (real git)', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'git-cli-exclude-'));
    await run('git', ['init', '-q'], { cwd: repo });
    await run('git', ['config', 'user.email', 'test@forgeroom.dev'], { cwd: repo });
    await run('git', ['config', 'user.name', 'ForgeRoom Test'], { cwd: repo });
    await run('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
    await run('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('keeps excluded untracked artifacts out of a commit while staging the deliverable', async () => {
    const git = new GitCli();

    // Simulate what the OpenClaw agent leaves in the worktree root.
    await writeFile(path.join(repo, 'SOUL.md'), 'persona');
    await writeFile(path.join(repo, 'HEARTBEAT.md'), 'beat');
    await mkdir(path.join(repo, '.openclaw'), { recursive: true });
    await writeFile(path.join(repo, '.openclaw', 'workspace-state.json'), '{}');
    await writeFile(path.join(repo, 'Docs-PING.md'), 'PONG'); // the deliverable

    await git.excludeFromWorktree({ cwd: repo, patterns: ['.openclaw/', 'SOUL.md', 'HEARTBEAT.md'] });
    await git.commit({ cwd: repo, message: 'deliverable' });

    const { stdout } = await run('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: repo });
    const committed = stdout.split('\n').filter((line) => line.length > 0);
    expect(committed).toEqual(['Docs-PING.md']);
  });

  it('appends each pattern idempotently across repeated calls', async () => {
    const git = new GitCli();

    await git.excludeFromWorktree({ cwd: repo, patterns: ['SOUL.md', '.openclaw/'] });
    await git.excludeFromWorktree({ cwd: repo, patterns: ['SOUL.md', '.openclaw/'] });

    const excludePath = path.join(repo, '.git', 'info', 'exclude');
    const lines = (await readFile(excludePath, 'utf8')).split('\n').filter((l) => l.trim().length > 0);
    expect(lines.filter((l) => l === 'SOUL.md')).toEqual(['SOUL.md']);
    expect(lines.filter((l) => l === '.openclaw/')).toEqual(['.openclaw/']);
  });

  it('resolves the shared exclude file from inside a linked worktree', async () => {
    const git = new GitCli();
    const wt = await mkdtemp(path.join(tmpdir(), 'git-cli-linkedwt-'));
    await rm(wt, { recursive: true, force: true });
    await run('git', ['worktree', 'add', '-q', wt, 'HEAD'], { cwd: repo });
    try {
      await writeFile(path.join(wt, 'SOUL.md'), 'persona');
      await writeFile(path.join(wt, 'keep.md'), 'real');

      await git.excludeFromWorktree({ cwd: wt, patterns: ['SOUL.md'] });
      await git.commit({ cwd: wt, message: 'from worktree' });

      const { stdout } = await run('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: wt });
      const committed = stdout.split('\n').filter((line) => line.length > 0);
      expect(committed).toEqual(['keep.md']);
    } finally {
      await run('git', ['worktree', 'remove', '--force', wt], { cwd: repo }).catch(() => undefined);
      await rm(wt, { recursive: true, force: true });
    }
  });
});
