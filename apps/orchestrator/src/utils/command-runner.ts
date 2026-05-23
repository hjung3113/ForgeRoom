import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { finished } from 'node:stream/promises';

const KILL_GRACE_MS = 100;

export interface CommandRunnerInput {
  command: string;
  cwd: string;
  stdoutPath: string;
  stderrPath: string;
  timeoutMs: number;
}

export interface CommandRunnerResult {
  command: string;
  exitCode: number;
  durationMs: number;
  stdoutPath: string;
  stderrPath: string;
  timedOut: boolean;
}

export interface CommandRunner {
  run(input: CommandRunnerInput): Promise<CommandRunnerResult>;
}

export class NodeCommandRunner implements CommandRunner {
  async run(input: CommandRunnerInput): Promise<CommandRunnerResult> {
    await Promise.all([
      mkdir(path.dirname(input.stdoutPath), { recursive: true }),
      mkdir(path.dirname(input.stderrPath), { recursive: true }),
    ]);

    const startedAt = Date.now();
    const stdout = createWriteStream(input.stdoutPath);
    const stderr = createWriteStream(input.stderrPath);
    let timedOut = false;
    const killTimeout = setTimeout(() => {
      if (timedOut) {
        terminateProcess(child.pid, 'SIGKILL');
      }
    }, input.timeoutMs + KILL_GRACE_MS);

    const child = spawn(input.command, {
      cwd: input.cwd,
      detached: process.platform !== 'win32',
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);

    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcess(child.pid, 'SIGTERM');
    }, input.timeoutMs);

    const exitCode = await new Promise<number>((resolve) => {
      child.once('error', (error: NodeJS.ErrnoException) => {
        stderr.write(`${error.message}\n`);
        resolve(error.code === 'ENOENT' ? 127 : 1);
      });

      child.once('close', (code) => {
        resolve(timedOut ? 1 : normalizeExitCode(code));
      });
    });

    clearTimeout(timeout);
    clearTimeout(killTimeout);
    stdout.end();
    stderr.end();
    await Promise.all([finished(stdout), finished(stderr)]);

    return {
      command: input.command,
      exitCode,
      durationMs: Date.now() - startedAt,
      stdoutPath: input.stdoutPath,
      stderrPath: input.stderrPath,
      timedOut,
    };
  }
}

function normalizeExitCode(code: number | null): number {
  return code ?? 1;
}

function terminateProcess(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) {
    return;
  }

  if (process.platform === 'win32') {
    try {
      process.kill(pid, signal);
    } catch {
      // The process may have exited between timeout firing and signal delivery.
    }
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process may have exited between timeout firing and signal delivery.
    }
  }
}
