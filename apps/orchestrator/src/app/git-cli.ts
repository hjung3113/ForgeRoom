import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

type ExecFileCallback = (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void;

export type GitExecFileFn = (
  file: string,
  args: string[],
  options: { cwd: string },
  callback: ExecFileCallback,
) => void;

const execFileAsync = promisify(execFile);

export interface GitCliOptions {
  execFileFn?: GitExecFileFn;
}

export class GitCli {
  private readonly execFile: (file: string, args: string[], options: { cwd: string }) => Promise<{ stdout: string }>;

  constructor(options: GitCliOptions = {}) {
    this.execFile =
      options.execFileFn === undefined
        ? async (file, args, execOptions): Promise<{ stdout: string }> => {
            const { stdout } = await execFileAsync(file, args, execOptions);
            return { stdout };
          }
        : async (file, args, execOptions): Promise<{ stdout: string }> =>
            new Promise((resolve, reject) => {
              options.execFileFn?.(file, args, execOptions, (error, stdout) => {
                if (error !== null) {
                  reject(error);
                  return;
                }
                resolve({ stdout });
              });
            });
  }

  async revParseHead(cwd: string): Promise<string> {
    const { stdout } = await this.execFile('git', ['rev-parse', 'HEAD'], { cwd });
    return stdout.trim();
  }

  async statusPorcelain(cwd: string): Promise<string> {
    const { stdout } = await this.execFile('git', ['status', '--porcelain'], { cwd });
    return stdout;
  }

  async statusPorcelainZPaths(cwd: string): Promise<string[]> {
    const { stdout } = await this.execFile('git', ['status', '--porcelain', '--untracked-files=all', '-z'], {
      cwd,
    });
    return parsePorcelainZ(stdout);
  }

  async worktreeExists(input: { cwd: string; path: string }): Promise<boolean> {
    const { stdout } = await this.execFile('git', ['worktree', 'list', '--porcelain'], {
      cwd: input.cwd,
    });
    return stdout.split('\n').some((line) => line === `worktree ${input.path}`);
  }

  async worktreeAddBranch(input: { cwd: string; branch: string; path: string; base: string }): Promise<void> {
    await this.execFile('git', ['worktree', 'add', '-b', input.branch, input.path, input.base], {
      cwd: input.cwd,
    });
  }

  async restoreFromHead(input: { cwd: string; paths: string[] }): Promise<void> {
    await this.execFile('git', ['restore', '--source=HEAD', '--worktree', '--', ...input.paths], {
      cwd: input.cwd,
    });
  }

  async isTracked(input: { cwd: string; rel: string }): Promise<boolean> {
    try {
      await this.execFile('git', ['ls-files', '--error-unmatch', '--', input.rel], {
        cwd: input.cwd,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Stage all changes and create a commit in the given worktree. Throws when
   * the underlying git command fails (e.g. nothing to commit after a clean
   * worktree — callers must check {@link statusPorcelain} first).
   */
  async commit(input: { cwd: string; message: string }): Promise<void> {
    await this.execFile('git', ['add', '--all'], { cwd: input.cwd });
    await this.execFile('git', ['commit', '--message', input.message], { cwd: input.cwd });
  }

  /**
   * Add local-only ignore rules to the worktree so untracked files matching
   * `patterns` are never staged by {@link commit} (`git add --all`). The rules
   * go into the git exclude file resolved via `git rev-parse --git-path
   * info/exclude` — for a linked worktree this resolves to the shared common
   * `.git/info/exclude`, so the rules are local to the managed clone and never
   * written into the target repository's tracked `.gitignore`. Idempotent: a
   * pattern already present (any line) is not appended again, so repeated calls
   * on resume/recovery do not duplicate lines. Only affects untracked files.
   */
  async excludeFromWorktree(input: { cwd: string; patterns: string[] }): Promise<void> {
    const { stdout } = await this.execFile('git', ['rev-parse', '--git-path', 'info/exclude'], {
      cwd: input.cwd,
    });
    const excludeFile = path.resolve(input.cwd, stdout.trim());
    const existing = await readFile(excludeFile, 'utf8').catch(() => '');
    const present = new Set(existing.split('\n').map((line) => line.trim()));
    const missing = input.patterns.filter((pattern) => !present.has(pattern));
    if (missing.length === 0) {
      return;
    }
    const prefix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    await writeFile(excludeFile, `${prefix}${missing.join('\n')}\n`, { flag: 'a' });
  }

  /**
   * Push the branch to the remote. When `remote` is omitted the git default
   * (origin) is used. Throws when the push fails (network error, auth, etc.).
   */
  async push(input: { cwd: string; branch: string; remote?: string }): Promise<void> {
    const remote = input.remote ?? 'origin';
    await this.execFile('git', ['push', remote, input.branch], { cwd: input.cwd });
  }
}

function parsePorcelainZ(stdout: string): string[] {
  const records = stdout.split('\0').filter((record) => record.length > 0);
  const paths: string[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record === undefined || record.length < 4) {
      continue;
    }
    const status = record.slice(0, 2);
    paths.push(record.slice(3));
    if (status[0] === 'R' || status[1] === 'R') {
      i += 1;
    }
  }
  return paths;
}
