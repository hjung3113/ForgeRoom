import { execFile } from 'node:child_process';
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
}
