import path from 'node:path';
import crypto from 'node:crypto';

import type { CommandRunner, CommandRunnerResult } from '../utils/command-runner';
import type { ApprovalGate } from './approval-gate';
import type { ProjectMeta } from './project-registry';
import type { TaskStore } from './task-store';
import type { CheckRunResult, CheckResult, Step, Task } from './types';

export type CheckRunnerCommandRunner = CommandRunner;

export interface CheckRunnerRequest {
  task: Task;
  step: Step;
  project: ProjectMeta;
}

export interface DefaultCheckRunnerOptions {
  commandRunner: CheckRunnerCommandRunner;
  taskStore: Pick<TaskStore, 'recordCheck' | 'updateStep'>;
  approvalGate: ApprovalGate;
  defaultTimeoutMs?: number;
  createCheckId?: () => string;
}

export const DEFAULT_CHECK_TIMEOUT_MS = 1_800_000;

export class DefaultCheckRunner {
  private readonly commandRunner: CheckRunnerCommandRunner;
  private readonly taskStore: Pick<TaskStore, 'recordCheck' | 'updateStep'>;
  private readonly approvalGate: ApprovalGate;
  private readonly defaultTimeoutMs: number;
  private readonly createCheckId: () => string;

  constructor(options: DefaultCheckRunnerOptions) {
    this.commandRunner = options.commandRunner;
    this.taskStore = options.taskStore;
    this.approvalGate = options.approvalGate;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
    this.createCheckId = options.createCheckId ?? crypto.randomUUID;
  }

  async run(request: CheckRunnerRequest): Promise<CheckRunResult> {
    const results: CheckResult[] = [];

    for (const [commandName, command] of Object.entries(request.project.commands)) {
      const paths = checkArtifactPaths(request.task.worktree_path, commandName);
      const decision = this.approvalGate.checkCommand(command, request.task.worktree_path);
      const commandResult = decision.allowed
        ? await this.commandRunner.run({
            command,
            cwd: request.task.worktree_path,
            stdoutPath: paths.stdoutPath,
            stderrPath: paths.stderrPath,
            timeoutMs: this.defaultTimeoutMs,
          })
        : deniedCommandResult(command, paths);

      const result = toCheckResult(commandName, commandResult);
      results.push(result);

      await this.taskStore.recordCheck({
        id: this.createCheckId(),
        step_row_id: request.step.id,
        check_fix_attempt: 0,
        command_name: commandName,
        command,
        exit_code: result.exitCode,
        stdout_path: result.stdoutPath,
        stderr_path: result.stderrPath,
        duration_ms: result.durationMs,
      });
    }

    const allPassed = results.every((result) => result.exitCode === 0);
    await this.taskStore.updateStep(request.step.id, {
      check_status: allPassed ? 'passed' : 'failed',
      check_fix_attempt: 0,
    });

    return { allPassed, results };
  }
}

function checkArtifactPaths(worktreePath: string, commandName: string): {
  stdoutPath: string;
  stderrPath: string;
} {
  const safeCommandName = commandName.replaceAll(/[^A-Za-z0-9_.-]/g, '_');
  const logRoot = path.join(worktreePath, '.forgeroom', 'logs');

  return {
    stdoutPath: path.join(logRoot, `check_${safeCommandName}.stdout`),
    stderrPath: path.join(logRoot, `check_${safeCommandName}.stderr`),
  };
}

function deniedCommandResult(
  command: string,
  paths: { stdoutPath: string; stderrPath: string },
): CommandRunnerResult {
  return {
    command,
    exitCode: 1,
    durationMs: 0,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
    timedOut: false,
  };
}

function toCheckResult(commandName: string, result: CommandRunnerResult): CheckResult {
  return {
    commandName,
    command: result.command,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    stdoutPath: result.stdoutPath,
    stderrPath: result.stderrPath,
  };
}
