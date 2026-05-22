import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { NodeCommandRunner } from './command-runner';

describe('NodeCommandRunner', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.map((tempRoot) => rm(tempRoot, { recursive: true, force: true })),
    );
    tempRoots.length = 0;
  });

  async function makeTempRoot(): Promise<string> {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'forgeroom-command-runner-'));
    tempRoots.push(tempRoot);
    return tempRoot;
  }

  it('runs a command string and writes stdout and stderr artifacts', async () => {
    const tempRoot = await makeTempRoot();
    const stdoutPath = path.join(tempRoot, 'artifacts', 'logs', 'check.stdout');
    const stderrPath = path.join(tempRoot, 'artifacts', 'logs', 'check.stderr');
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
      "process.stdout.write('stdout artifact'); process.stderr.write('stderr artifact'); process.exit(7);",
    )}`;

    const result = await new NodeCommandRunner().run({
      command,
      cwd: tempRoot,
      stdoutPath,
      stderrPath,
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({
      command,
      exitCode: 7,
      stdoutPath,
      stderrPath,
      timedOut: false,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    await expect(readFile(stdoutPath, 'utf8')).resolves.toBe('stdout artifact');
    await expect(readFile(stderrPath, 'utf8')).resolves.toBe('stderr artifact');
  });

  it('normalizes command-not-found failures to exit code 127 and writes stderr', async () => {
    const tempRoot = await makeTempRoot();
    const stdoutPath = path.join(tempRoot, 'stdout.log');
    const stderrPath = path.join(tempRoot, 'nested', 'stderr.log');

    const result = await new NodeCommandRunner().run({
      command: 'forgeroom-command-that-does-not-exist',
      cwd: tempRoot,
      stdoutPath,
      stderrPath,
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({
      command: 'forgeroom-command-that-does-not-exist',
      exitCode: 127,
      stdoutPath,
      stderrPath,
      timedOut: false,
    });
    await expect(readFile(stdoutPath, 'utf8')).resolves.toBe('');
    await expect(readFile(stderrPath, 'utf8')).resolves.toContain(
      'forgeroom-command-that-does-not-exist',
    );
  });

  it('terminates commands that exceed the timeout and preserves artifact paths', async () => {
    const tempRoot = await makeTempRoot();
    const stdoutPath = path.join(tempRoot, 'timeout', 'stdout.log');
    const stderrPath = path.join(tempRoot, 'timeout', 'stderr.log');
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
      "process.stdout.write('started'); setInterval(() => {}, 1000);",
    )}`;

    const result = await new NodeCommandRunner().run({
      command,
      cwd: tempRoot,
      stdoutPath,
      stderrPath,
      timeoutMs: 50,
    });

    expect(result).toMatchObject({
      command,
      exitCode: 1,
      stdoutPath,
      stderrPath,
      timedOut: true,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(50);
    await expect(readFile(stdoutPath, 'utf8')).resolves.toEqual(expect.any(String));
    await expect(readFile(stderrPath, 'utf8')).resolves.toBe('');
  });

  it('force-kills commands that ignore the first timeout signal', async () => {
    const tempRoot = await makeTempRoot();
    const stdoutPath = path.join(tempRoot, 'ignore-term', 'stdout.log');
    const stderrPath = path.join(tempRoot, 'ignore-term', 'stderr.log');
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
      "process.on('SIGTERM', () => {}); process.stdout.write('started'); setInterval(() => {}, 1000);",
    )}`;

    const result = await new NodeCommandRunner().run({
      command,
      cwd: tempRoot,
      stdoutPath,
      stderrPath,
      timeoutMs: 50,
    });

    expect(result).toMatchObject({
      command,
      exitCode: 1,
      stdoutPath,
      stderrPath,
      timedOut: true,
    });
    await expect(readFile(stdoutPath, 'utf8')).resolves.toEqual(expect.any(String));
  });
});
