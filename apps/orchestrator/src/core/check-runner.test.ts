import { describe, expect, it } from 'vitest';

import {
  agentResult,
  checkRunnerHarness,
  FakeArtifactStore,
  numberedLines,
  project,
  step,
  task,
} from './test-support/check-runner-fixtures.js';

describe('DefaultCheckRunner', () => {
  it('runs project commands in order, records attempt 0 checks, and marks the execute step passed', async () => {
    const { commandRunner, taskStore, runner } = checkRunnerHarness({
      commandResults: [
        { exitCode: 0, durationMs: 10 },
        { exitCode: 0, durationMs: 20 },
      ],
      defaultTimeoutMs: 1_800_000,
    });

    const result = await runner.run({ task: task(), step: step(), project: project() });

    expect(result.allPassed).toBe(true);
    expect(commandRunner.requests.map((request) => request.command)).toEqual([
      'pnpm lint',
      'pnpm test:unit',
    ]);
    expect(commandRunner.requests).toEqual([
      {
        command: 'pnpm lint',
        cwd: '/tmp/forgeroom/worktrees/task-1',
        stdoutPath: '/tmp/forgeroom/worktrees/task-1/.forgeroom/logs/check_0_lint.stdout',
        stderrPath: '/tmp/forgeroom/worktrees/task-1/.forgeroom/logs/check_0_lint.stderr',
        timeoutMs: 1_800_000,
      },
      {
        command: 'pnpm test:unit',
        cwd: '/tmp/forgeroom/worktrees/task-1',
        stdoutPath: '/tmp/forgeroom/worktrees/task-1/.forgeroom/logs/check_0_test.stdout',
        stderrPath: '/tmp/forgeroom/worktrees/task-1/.forgeroom/logs/check_0_test.stderr',
        timeoutMs: 1_800_000,
      },
    ]);
    expect(taskStore.checks).toMatchObject([
      {
        id: 'check-1',
        step_row_id: 'step-row-1',
        check_fix_attempt: 0,
        command_name: 'lint',
        command: 'pnpm lint',
        exit_code: 0,
      },
      {
        id: 'check-2',
        step_row_id: 'step-row-1',
        check_fix_attempt: 0,
        command_name: 'test',
        command: 'pnpm test:unit',
        exit_code: 0,
      },
    ]);
    expect(taskStore.stepPatches).toEqual([
      { id: 'step-row-1', patch: { check_status: 'passed', check_fix_attempt: 0 } },
    ]);
  });

  it('records all initial command results before invoking the check-fix flow', async () => {
    const { taskStore, runner } = checkRunnerHarness({
      commandResults: [
        { exitCode: 0, durationMs: 10 },
        { exitCode: 127, durationMs: 5 },
        { exitCode: 2, durationMs: 8 },
        { exitCode: 0, durationMs: 11 },
        { exitCode: 0, durationMs: 12 },
        { exitCode: 0, durationMs: 13 },
      ],
      agentResults: [agentResult()],
    });

    const result = await runner.run({
      task: task(),
      step: step(),
      project: project({
        lint: 'pnpm lint',
        typecheck: 'pnpm typecheck',
        test: 'pnpm test:unit',
      }),
    });

    expect(result.allPassed).toBe(true);
    expect(result.results.map((check) => check.exitCode)).toEqual([0, 0, 0]);
    expect(taskStore.checks.map((check) => check.id)).toEqual([
      'check-1',
      'check-2',
      'check-3',
      'check-4',
      'check-5',
      'check-6',
    ]);
    expect(taskStore.checks.map((check) => check.check_fix_attempt)).toEqual([0, 0, 0, 1, 1, 1]);
    expect(taskStore.stepPatches).toEqual([
      { id: 'step-row-1', patch: { check_status: 'fixed', check_fix_attempt: 1 } },
    ]);
  });

  it('runs one check-fix resume after initial command failure, records attempt 1 checks, and marks the original step fixed', async () => {
    const artifactStore = new FakeArtifactStore();
    artifactStore.files.set(
      '/tmp/forgeroom/worktrees/task-1/.forgeroom/logs/check_0_lint.stdout',
      numberedLines('stdout', 205),
    );
    artifactStore.files.set(
      '/tmp/forgeroom/worktrees/task-1/.forgeroom/logs/check_0_lint.stderr',
      numberedLines('stderr', 205),
    );
    const { commandRunner, taskStore, agentRunner, runner } = checkRunnerHarness({
      commandResults: [
        { exitCode: 2, durationMs: 10 },
        { exitCode: 0, durationMs: 20 },
        { exitCode: 0, durationMs: 30 },
        { exitCode: 0, durationMs: 40 },
      ],
      agentResults: [agentResult()],
      artifactStore,
      defaultTimeoutMs: 1_800_000,
    });

    const result = await runner.run({ task: task(), step: step(), project: project() });

    expect(result.allPassed).toBe(true);
    expect(commandRunner.requests.map((request) => request.command)).toEqual([
      'pnpm lint',
      'pnpm test:unit',
      'pnpm lint',
      'pnpm test:unit',
    ]);
    expect(taskStore.checks.map((check) => check.check_fix_attempt)).toEqual([0, 0, 1, 1]);
    expect(taskStore.checks.map((check) => check.stdout_path)).toEqual([
      '/tmp/forgeroom/worktrees/task-1/.forgeroom/logs/check_0_lint.stdout',
      '/tmp/forgeroom/worktrees/task-1/.forgeroom/logs/check_0_test.stdout',
      '/tmp/forgeroom/worktrees/task-1/.forgeroom/logs/check_1_lint.stdout',
      '/tmp/forgeroom/worktrees/task-1/.forgeroom/logs/check_1_test.stdout',
    ]);
    expect(taskStore.stepPatches).toEqual([
      { id: 'step-row-1', patch: { check_status: 'fixed', check_fix_attempt: 1 } },
    ]);
    expect(taskStore.taskStatusPatches).toEqual([]);
    expect(artifactStore.writes).toHaveLength(1);
    expect(artifactStore.writes[0]?.path).toBe(
      '/tmp/forgeroom/worktrees/task-1/.forgeroom/prompts/check_fix_execute.md',
    );
    expect(artifactStore.writes[0]?.content).toContain('stdout 006');
    expect(artifactStore.writes[0]?.content).not.toContain('stdout 005');
    expect(artifactStore.writes[0]?.content).toContain('stderr 006');
    expect(artifactStore.writes[0]?.content).not.toContain('stderr 005');
    expect(agentRunner.resumeRequests).toEqual([
      {
        agentId: 'implementer',
        promptPath: '/tmp/forgeroom/worktrees/task-1/.forgeroom/prompts/01_execute.md',
        addendumPromptPath:
          '/tmp/forgeroom/worktrees/task-1/.forgeroom/prompts/check_fix_execute.md',
        outputPath: '/tmp/forgeroom/worktrees/task-1/.forgeroom/outputs/check_fix_execute.md',
        stdoutPath: '/tmp/forgeroom/worktrees/task-1/.forgeroom/logs/check_fix_execute.stdout',
        stderrPath: '/tmp/forgeroom/worktrees/task-1/.forgeroom/logs/check_fix_execute.stderr',
        cwd: '/tmp/forgeroom/worktrees/task-1',
        mode: 'headless',
        sessionId: null,
        attempt: 1,
        timeoutMs: 1_800_000,
      },
    ]);
  });

  it('fails the original step and task when checks still fail after one check-fix resume', async () => {
    const { taskStore, agentRunner, runner } = checkRunnerHarness({
      commandResults: [
        { exitCode: 2, durationMs: 10 },
        { exitCode: 0, durationMs: 20 },
        { exitCode: 1, durationMs: 30 },
        { exitCode: 0, durationMs: 40 },
      ],
      agentResults: [agentResult()],
      defaultTimeoutMs: 1_800_000,
    });

    const result = await runner.run({ task: task(), step: step(), project: project() });

    expect(result.allPassed).toBe(false);
    expect(agentRunner.resumeRequests).toHaveLength(1);
    expect(taskStore.checks.map((check) => check.check_fix_attempt)).toEqual([0, 0, 1, 1]);
    expect(taskStore.stepPatches).toEqual([
      {
        id: 'step-row-1',
        patch: {
          check_status: 'failed',
          check_fix_attempt: 1,
          failure_reason: 'check_failed_after_fix',
        },
      },
    ]);
    expect(taskStore.taskStatusPatches).toEqual([
      { id: 'task-1', status: 'failed', failureReason: 'check_failed_after_fix' },
    ]);
  });

  it('rejects unsafe project commands before command execution', async () => {
    const { commandRunner, taskStore, runner } = checkRunnerHarness({
      commandResults: [
        { exitCode: 0, durationMs: 10 },
        { exitCode: 0, durationMs: 20 },
      ],
      agentResults: [agentResult()],
    });
    const unsafeProject = project({ lint: 'rm -rf /', test: 'pnpm test:unit' });

    const result = await runner.run({ task: task(), step: step(), project: unsafeProject });

    expect(commandRunner.requests).toEqual([
      {
        command: 'pnpm test:unit',
        cwd: '/tmp/forgeroom/worktrees/task-1',
        stdoutPath: '/tmp/forgeroom/worktrees/task-1/.forgeroom/logs/check_0_test.stdout',
        stderrPath: '/tmp/forgeroom/worktrees/task-1/.forgeroom/logs/check_0_test.stderr',
        timeoutMs: 1_800_000,
      },
      {
        command: 'pnpm test:unit',
        cwd: '/tmp/forgeroom/worktrees/task-1',
        stdoutPath: '/tmp/forgeroom/worktrees/task-1/.forgeroom/logs/check_1_test.stdout',
        stderrPath: '/tmp/forgeroom/worktrees/task-1/.forgeroom/logs/check_1_test.stderr',
        timeoutMs: 1_800_000,
      },
    ]);
    expect(result.allPassed).toBe(false);
    expect(taskStore.checks).toMatchObject([
      {
        id: 'check-1',
        command_name: 'lint',
        command: 'rm -rf /',
        exit_code: 1,
      },
      {
        id: 'check-2',
        command_name: 'test',
        command: 'pnpm test:unit',
        exit_code: 0,
      },
      {
        id: 'check-3',
        command_name: 'lint',
        command: 'rm -rf /',
        exit_code: 1,
        check_fix_attempt: 1,
      },
      {
        id: 'check-4',
        command_name: 'test',
        command: 'pnpm test:unit',
        exit_code: 0,
        check_fix_attempt: 1,
      },
    ]);
    expect(taskStore.stepPatches).toEqual([
      {
        id: 'step-row-1',
        patch: {
          check_status: 'failed',
          check_fix_attempt: 1,
          failure_reason: 'check_failed_after_fix',
        },
      },
    ]);
    expect(taskStore.taskStatusPatches).toEqual([
      { id: 'task-1', status: 'failed', failureReason: 'check_failed_after_fix' },
    ]);
  });
});
