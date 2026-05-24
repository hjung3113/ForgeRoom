import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { spawnCaptured, terminateProcessGroup, type SpawnFn } from './subprocess.js';

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 123;
}

function fakeSpawnWith(
  child: FakeChild,
  calls: Array<{ bin: string; args: string[]; options: SpawnOptions }>,
  onSpawn?: () => void,
): SpawnFn {
  return ((bin: string, args: string[], options: SpawnOptions): ChildProcess => {
    calls.push({ bin, args, options });
    onSpawn?.();
    return child as unknown as ChildProcess;
  }) as SpawnFn;
}

function spawnSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('terminateProcessGroup', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does nothing when the child has no pid yet', () => {
    const kill = vi.spyOn(process, 'kill');

    terminateProcessGroup(undefined, 'SIGTERM');

    expect(kill).not.toHaveBeenCalled();
  });

  it('falls back to killing the child pid when process-group termination fails', () => {
    if (process.platform === 'win32') {
      return;
    }
    const kill = vi
      .spyOn(process, 'kill')
      .mockImplementationOnce(() => {
        throw new Error('missing process group');
      })
      .mockImplementationOnce(() => true);

    terminateProcessGroup(123, 'SIGKILL');

    expect(kill).toHaveBeenNthCalledWith(1, -123, 'SIGKILL');
    expect(kill).toHaveBeenNthCalledWith(2, 123, 'SIGKILL');
  });
});

describe('spawnCaptured', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'forgeroom-subprocess-'));
    tempRoots.push(root);
    return root;
  }

  it('spawns the requested process and captures stdout and stderr when requested', async () => {
    const root = await tempRoot();
    const child = new FakeChild();
    const calls: Array<{ bin: string; args: string[]; options: SpawnOptions }> = [];
    const spawned = spawnSignal();
    const run = spawnCaptured({
      bin: 'tool',
      args: ['arg'],
      cwd: root,
      shell: false,
      stdoutPath: join(root, 'logs', 'stdout.log'),
      stderrPath: join(root, 'logs', 'stderr.log'),
      capture: true,
      timeoutMs: 5_000,
      killGraceMs: 100,
      spawnFn: fakeSpawnWith(child, calls, spawned.resolve),
      now: () => 100,
      writeSpawnErrorToStderr: false,
    });

    await spawned.promise;
    child.stdout.write('out');
    child.stderr.write('err');
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 7);

    const result = await run;

    expect(result).toMatchObject({
      rawExit: 7,
      stdoutBuf: 'out',
      stderrBuf: 'err',
      timedOut: false,
      spawnError: null,
      durationMs: 0,
    });
    expect(calls[0]).toMatchObject({
      bin: 'tool',
      args: ['arg'],
      options: { cwd: root, shell: false, detached: process.platform !== 'win32' },
    });
    await expect(readFile(join(root, 'logs', 'stdout.log'), 'utf8')).resolves.toBe('out');
    await expect(readFile(join(root, 'logs', 'stderr.log'), 'utf8')).resolves.toBe('err');
  });

  it('returns empty buffers when capture is disabled while preserving output files', async () => {
    const root = await tempRoot();
    const child = new FakeChild();
    const spawned = spawnSignal();
    const run = spawnCaptured({
      bin: 'tool',
      args: [],
      cwd: root,
      shell: true,
      stdoutPath: join(root, 'stdout.log'),
      stderrPath: join(root, 'stderr.log'),
      capture: false,
      timeoutMs: 5_000,
      killGraceMs: 100,
      spawnFn: fakeSpawnWith(child, [], spawned.resolve),
      writeSpawnErrorToStderr: false,
    });

    await spawned.promise;
    child.stdout.write('file-only');
    child.stderr.end();
    child.stdout.end();
    child.emit('close', 0);

    const result = await run;

    expect(result.stdoutBuf).toBe('');
    expect(result.stderrBuf).toBe('');
    await expect(readFile(join(root, 'stdout.log'), 'utf8')).resolves.toBe('file-only');
  });

  it('signals timeout with SIGTERM and escalates to SIGKILL after the grace window', async () => {
    const root = await tempRoot();
    vi.useFakeTimers();
    const child = new FakeChild();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const spawned = spawnSignal();
    const run = spawnCaptured({
      bin: 'tool',
      args: [],
      cwd: root,
      stdoutPath: join(root, 'stdout.log'),
      stderrPath: join(root, 'stderr.log'),
      capture: false,
      timeoutMs: 50,
      killGraceMs: 100,
      spawnFn: fakeSpawnWith(child, [], spawned.resolve),
      writeSpawnErrorToStderr: false,
    });

    await spawned.promise;
    await vi.advanceTimersByTimeAsync(50);
    expect(kill).toHaveBeenCalledWith(process.platform === 'win32' ? 123 : -123, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(100);
    expect(kill).toHaveBeenCalledWith(process.platform === 'win32' ? 123 : -123, 'SIGKILL');
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0);

    const result = await run;

    expect(result.timedOut).toBe(true);
    expect(result.rawExit).toBe(0);
  });

  it('records spawn errors and optionally writes them to stderr', async () => {
    const root = await tempRoot();
    const child = new FakeChild();
    const error = Object.assign(new Error('missing executable'), { code: 'ENOENT' });
    const spawned = spawnSignal();
    const run = spawnCaptured({
      bin: 'missing',
      args: [],
      cwd: root,
      stdoutPath: join(root, 'stdout.log'),
      stderrPath: join(root, 'stderr.log'),
      capture: true,
      timeoutMs: 5_000,
      killGraceMs: 100,
      spawnFn: fakeSpawnWith(child, [], spawned.resolve),
      writeSpawnErrorToStderr: true,
    });

    await spawned.promise;
    child.stdout.end();
    child.stderr.end();
    child.emit('error', error);

    const result = await run;

    expect(result.rawExit).toBe(127);
    expect(result.spawnError).toBe(error);
    await expect(readFile(join(root, 'stderr.log'), 'utf8')).resolves.toContain('missing executable');
  });

  it('does not install timeout timers when timeoutMs is undefined', async () => {
    const root = await tempRoot();
    vi.useFakeTimers();
    const child = new FakeChild();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const spawned = spawnSignal();
    const run = spawnCaptured({
      bin: 'tool',
      args: [],
      cwd: root,
      stdoutPath: join(root, 'stdout.log'),
      stderrPath: join(root, 'stderr.log'),
      capture: false,
      killGraceMs: 100,
      spawnFn: fakeSpawnWith(child, [], spawned.resolve),
      writeSpawnErrorToStderr: false,
    });

    await spawned.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0);

    const result = await run;

    expect(result.timedOut).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it('captures real child output and writes the same bytes to files', async () => {
    const root = await tempRoot();

    const result = await spawnCaptured({
      bin: process.execPath,
      args: ['-e', "process.stdout.write('real-out'); process.stderr.write('real-err');"],
      cwd: root,
      stdoutPath: join(root, 'stdout.log'),
      stderrPath: join(root, 'stderr.log'),
      capture: true,
      timeoutMs: 5_000,
      killGraceMs: 100,
      spawnFn: spawn,
      writeSpawnErrorToStderr: false,
    });

    expect(result.stdoutBuf).toBe('real-out');
    expect(result.stderrBuf).toBe('real-err');
    await expect(readFile(join(root, 'stdout.log'), 'utf8')).resolves.toBe('real-out');
    await expect(readFile(join(root, 'stderr.log'), 'utf8')).resolves.toBe('real-err');
  });
});
