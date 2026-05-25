import path from 'node:path';
import crypto from 'node:crypto';

import type { AgentRunner } from '../agent-runtime/agent-runner.js';
import type { CommandRunner, CommandRunnerResult } from '../../utils/command-runner.js';
import type { ApprovalGate } from './approval-gate.js';
import type { ProjectMeta } from '../registries/project-registry.js';
import type { TaskStore } from '../task-store.js';
import type { CheckRunResult, CheckResult, Step, Task } from '../types.js';

export type CheckRunnerCommandRunner = CommandRunner;

export interface CheckRunnerRequest {
  task: Task;
  step: Step;
  project: ProjectMeta;
}

export interface DefaultCheckRunnerOptions {
  commandRunner: CheckRunnerCommandRunner;
  agentRunner: AgentRunner;
  taskStore: Pick<TaskStore, 'recordCheck' | 'updateStep' | 'updateTaskStatus'>;
  approvalGate: ApprovalGate;
  artifactStore: CheckRunnerArtifactStore;
  defaultTimeoutMs?: number;
  createCheckId?: () => string;
}

export const DEFAULT_CHECK_TIMEOUT_MS = 1_800_000;
const CHECK_FAILED_AFTER_FIX = 'check_failed_after_fix';
const CHECK_FIX_ATTEMPT = 1;
const INITIAL_CHECK_ATTEMPT = 0;

export interface CheckRunnerArtifactStore {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

export class DefaultCheckRunner {
  private readonly commandRunner: CheckRunnerCommandRunner;
  private readonly agentRunner: AgentRunner;
  private readonly taskStore: Pick<TaskStore, 'recordCheck' | 'updateStep' | 'updateTaskStatus'>;
  private readonly approvalGate: ApprovalGate;
  private readonly artifactStore: CheckRunnerArtifactStore;
  private readonly defaultTimeoutMs: number;
  private readonly createCheckId: () => string;

  constructor(options: DefaultCheckRunnerOptions) {
    this.commandRunner = options.commandRunner;
    this.agentRunner = options.agentRunner;
    this.taskStore = options.taskStore;
    this.approvalGate = options.approvalGate;
    this.artifactStore = options.artifactStore;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
    this.createCheckId = options.createCheckId ?? crypto.randomUUID;
  }

  async run(request: CheckRunnerRequest): Promise<CheckRunResult> {
    const initialRun = await this.runCommands(request, INITIAL_CHECK_ATTEMPT);
    if (initialRun.allPassed) {
      await this.taskStore.updateStep(request.step.id, {
        check_status: 'passed',
        check_fix_attempt: INITIAL_CHECK_ATTEMPT,
      });

      return initialRun;
    }

    const checkFixPaths = checkFixArtifactPaths(request.task.worktree_path, request.step.step_id);
    await this.writeCheckFixPrompt(checkFixPaths.promptPath, initialRun.results);
    await this.agentRunner.resume({
      agentId: request.step.agent_id,
      promptPath: request.step.prompt_path,
      addendumPromptPath: checkFixPaths.promptPath,
      outputPath: checkFixPaths.outputPath,
      stdoutPath: checkFixPaths.stdoutPath,
      stderrPath: checkFixPaths.stderrPath,
      cwd: request.task.worktree_path,
      mode: 'headless',
      sessionId: null,
      attempt: CHECK_FIX_ATTEMPT,
      timeoutMs: this.defaultTimeoutMs,
    });

    const retryRun = await this.runCommands(request, CHECK_FIX_ATTEMPT);
    if (retryRun.allPassed) {
      await this.taskStore.updateStep(request.step.id, {
        check_status: 'fixed',
        check_fix_attempt: CHECK_FIX_ATTEMPT,
      });

      return retryRun;
    }

    await this.taskStore.updateStep(request.step.id, {
      check_status: 'failed',
      check_fix_attempt: CHECK_FIX_ATTEMPT,
      failure_reason: CHECK_FAILED_AFTER_FIX,
    });
    await this.taskStore.updateTaskStatus(request.task.id, 'failed', CHECK_FAILED_AFTER_FIX);

    return retryRun;
  }

  private async runCommands(
    request: CheckRunnerRequest,
    checkFixAttempt: number,
  ): Promise<CheckRunResult> {
    const results: CheckResult[] = [];

    for (const [commandName, command] of Object.entries(request.project.commands)) {
      const paths = checkArtifactPaths(request.task.worktree_path, commandName, checkFixAttempt);
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
        check_fix_attempt: checkFixAttempt,
        command_name: commandName,
        command,
        exit_code: result.exitCode,
        stdout_path: result.stdoutPath,
        stderr_path: result.stderrPath,
        duration_ms: result.durationMs,
      });
    }

    const allPassed = results.every((result) => result.exitCode === 0);
    return { allPassed, results };
  }

  private async writeCheckFixPrompt(promptPath: string, results: CheckResult[]): Promise<void> {
    const failedResults = results.filter((result) => result.exitCode !== 0);
    const sections = await Promise.all(
      failedResults.map(async (result) => {
        const [stdout, stderr] = await Promise.all([
          this.artifactStore.readFile(result.stdoutPath),
          this.artifactStore.readFile(result.stderrPath),
        ]);

        return [
          `## ${result.commandName}`,
          '',
          `Command: ${result.command}`,
          `Exit code: ${String(result.exitCode)}`,
          '',
          '### Last 200 stdout lines',
          '',
          fence(lastLines(stdout, 200)),
          '',
          '### Last 200 stderr lines',
          '',
          fence(lastLines(stderr, 200)),
        ].join('\n');
      }),
    );

    await this.artifactStore.writeFile(
      promptPath,
      [
        'The project verification commands failed after your implementation.',
        'Fix the code in the current worktree, then save a concise summary of the fix to the requested output path.',
        '',
        ...sections,
        '',
      ].join('\n'),
    );
  }
}

function checkArtifactPaths(worktreePath: string, commandName: string, checkFixAttempt: number): {
  stdoutPath: string;
  stderrPath: string;
} {
  const safeCommandName = commandName.replaceAll(/[^A-Za-z0-9_.-]/g, '_');
  const logRoot = path.join(worktreePath, '.forgeroom', 'logs');

  return {
    stdoutPath: path.join(logRoot, `check_${String(checkFixAttempt)}_${safeCommandName}.stdout`),
    stderrPath: path.join(logRoot, `check_${String(checkFixAttempt)}_${safeCommandName}.stderr`),
  };
}

function checkFixArtifactPaths(
  worktreePath: string,
  stepId: string,
): {
  promptPath: string;
  outputPath: string;
  stdoutPath: string;
  stderrPath: string;
} {
  const safeStepId = stepId.replaceAll(/[^A-Za-z0-9_.-]/g, '_');
  const artifactName = `check_fix_${safeStepId}`;

  return {
    promptPath: path.join(worktreePath, '.forgeroom', 'prompts', `${artifactName}.md`),
    outputPath: path.join(worktreePath, '.forgeroom', 'outputs', `${artifactName}.md`),
    stdoutPath: path.join(worktreePath, '.forgeroom', 'logs', `${artifactName}.stdout`),
    stderrPath: path.join(worktreePath, '.forgeroom', 'logs', `${artifactName}.stderr`),
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

function lastLines(content: string, lineCount: number): string {
  const lines = content.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - lineCount)).join('\n');
}

function fence(content: string): string {
  return ['```', content, '```'].join('\n');
}
