import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { finished } from 'node:stream/promises';

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface SpawnCapturedOptions {
  bin: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  stdoutPath: string;
  stderrPath: string;
  capture?: boolean;
  timeoutMs?: number;
  killGraceMs: number;
  spawnFn?: SpawnFn;
  now?: () => number;
  writeSpawnErrorToStderr: boolean;
}

export interface SpawnCapturedResult {
  rawExit: number;
  stdoutBuf: string;
  stderrBuf: string;
  timedOut: boolean;
  spawnError: NodeJS.ErrnoException | null;
  durationMs: number;
}

export async function spawnCaptured(options: SpawnCapturedOptions): Promise<SpawnCapturedResult> {
  await Promise.all([
    mkdir(dirname(options.stdoutPath), { recursive: true }),
    mkdir(dirname(options.stderrPath), { recursive: true }),
  ]);

  const now = options.now ?? Date.now;
  const startedAt = now();
  const stdout = createWriteStream(options.stdoutPath);
  const stderr = createWriteStream(options.stderrPath);
  const spawnFn: SpawnFn = options.spawnFn ?? spawn;
  const child = spawnFn(options.bin, options.args, {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== 'win32',
    shell: options.shell ?? false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdoutBuf = '';
  let stderrBuf = '';
  if (options.capture === true) {
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });
  }
  child.stdout?.pipe(stdout);
  child.stderr?.pipe(stderr);

  let timedOut = false;
  let spawnError: NodeJS.ErrnoException | null = null;
  const timeout =
    options.timeoutMs === undefined
      ? null
      : setTimeout(() => {
          timedOut = true;
          terminateProcessGroup(child.pid, 'SIGTERM');
        }, options.timeoutMs);
  const killTimer =
    options.timeoutMs === undefined
      ? null
      : setTimeout(() => {
          if (timedOut) {
            terminateProcessGroup(child.pid, 'SIGKILL');
          }
        }, options.timeoutMs + options.killGraceMs);

  const rawExit = await new Promise<number>((resolve) => {
    child.once('error', (error: NodeJS.ErrnoException) => {
      spawnError = error;
      if (options.writeSpawnErrorToStderr) {
        stderr.write(`${error.message}\n`);
      }
      resolve(error.code === 'ENOENT' ? 127 : 1);
    });
    child.once('close', (code) => {
      resolve(code ?? 1);
    });
  });

  if (timeout !== null) {
    clearTimeout(timeout);
  }
  if (killTimer !== null) {
    clearTimeout(killTimer);
  }
  stdout.end();
  stderr.end();
  await Promise.all([finished(stdout), finished(stderr)]);

  return {
    rawExit,
    stdoutBuf,
    stderrBuf,
    timedOut,
    spawnError,
    durationMs: now() - startedAt,
  };
}

export function terminateProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
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
