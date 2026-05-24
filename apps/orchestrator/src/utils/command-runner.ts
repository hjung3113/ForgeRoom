import { spawnCaptured } from './subprocess.js';

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
    const result = await spawnCaptured({
      bin: input.command,
      args: [],
      cwd: input.cwd,
      shell: true,
      stdoutPath: input.stdoutPath,
      stderrPath: input.stderrPath,
      capture: false,
      timeoutMs: input.timeoutMs,
      killGraceMs: KILL_GRACE_MS,
      writeSpawnErrorToStderr: true,
    });

    const exitCode =
      result.spawnError !== null
        ? result.spawnError.code === 'ENOENT'
          ? 127
          : 1
        : result.timedOut
          ? 1
          : normalizeExitCode(result.rawExit);

    return {
      command: input.command,
      exitCode,
      durationMs: result.durationMs,
      stdoutPath: input.stdoutPath,
      stderrPath: input.stderrPath,
      timedOut: result.timedOut,
    };
  }
}

function normalizeExitCode(code: number | null): number {
  return code ?? 1;
}
