import { describe, expect, it } from 'vitest';

import { ApprovalGate } from './approval-gate';
import { DefaultCheckRunner, type CheckRunnerCommandRunner } from './check-runner';
import type { ProjectMeta } from './project-registry';
import type { CreateCheckInput, TaskStore } from './task-store';
import type { Check, Step, Task } from './types';

class FakeCommandRunner implements CheckRunnerCommandRunner {
  requests: Array<Parameters<CheckRunnerCommandRunner['run']>[0]> = [];
  results: Array<{ exitCode: number; durationMs: number; timedOut?: boolean }> = [];

  run(input: Parameters<CheckRunnerCommandRunner['run']>[0]) {
    this.requests.push(input);
    const result = this.results.shift();
    if (!result) {
      throw new Error('missing fake command result');
    }

    return Promise.resolve({
      command: input.command,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      stdoutPath: input.stdoutPath,
      stderrPath: input.stderrPath,
      timedOut: result.timedOut ?? false,
    });
  }
}

class FakeTaskStore implements Pick<TaskStore, 'recordCheck' | 'updateStep'> {
  checks: Check[] = [];
  stepPatches: Array<{ id: string; patch: Partial<Step> }> = [];

  recordCheck(input: CreateCheckInput): Promise<Check> {
    const check = { ...input, created_at: input.created_at ?? new Date() };
    this.checks.push(check);
    return Promise.resolve(check);
  }

  updateStep(id: string, patch: Partial<Step>): Promise<void> {
    this.stepPatches.push({ id, patch });
    return Promise.resolve();
  }
}

function checkIds(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `check-${String(next)}`;
  };
}

describe('DefaultCheckRunner', () => {
  it('runs project commands in order, records attempt 0 checks, and marks the execute step passed', async () => {
    const commandRunner = new FakeCommandRunner();
    commandRunner.results = [
      { exitCode: 0, durationMs: 10 },
      { exitCode: 0, durationMs: 20 },
    ];
    const taskStore = new FakeTaskStore();
    const runner = new DefaultCheckRunner({
      commandRunner,
      taskStore,
      approvalGate: new ApprovalGate(),
      defaultTimeoutMs: 1_800_000,
      createCheckId: checkIds(),
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
        stdoutPath: '/tmp/forgeroom/worktrees/task-1/.forgeroom/logs/check_lint.stdout',
        stderrPath: '/tmp/forgeroom/worktrees/task-1/.forgeroom/logs/check_lint.stderr',
        timeoutMs: 1_800_000,
      },
      {
        command: 'pnpm test:unit',
        cwd: '/tmp/forgeroom/worktrees/task-1',
        stdoutPath: '/tmp/forgeroom/worktrees/task-1/.forgeroom/logs/check_test.stdout',
        stderrPath: '/tmp/forgeroom/worktrees/task-1/.forgeroom/logs/check_test.stderr',
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

  it('records all command results after a failure and marks the execute step failed without invoking fix flow yet', async () => {
    const commandRunner = new FakeCommandRunner();
    commandRunner.results = [
      { exitCode: 0, durationMs: 10 },
      { exitCode: 127, durationMs: 5 },
      { exitCode: 2, durationMs: 8 },
    ];
    const taskStore = new FakeTaskStore();
    const runner = new DefaultCheckRunner({
      commandRunner,
      taskStore,
      approvalGate: new ApprovalGate(),
      createCheckId: checkIds(),
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

    expect(result.allPassed).toBe(false);
    expect(result.results.map((check) => check.exitCode)).toEqual([0, 127, 2]);
    expect(taskStore.checks.map((check) => check.id)).toEqual(['check-1', 'check-2', 'check-3']);
    expect(taskStore.stepPatches).toEqual([
      { id: 'step-row-1', patch: { check_status: 'failed', check_fix_attempt: 0 } },
    ]);
  });

  it('rejects unsafe project commands before command execution', async () => {
    const commandRunner = new FakeCommandRunner();
    commandRunner.results = [{ exitCode: 0, durationMs: 10 }];
    const taskStore = new FakeTaskStore();
    const runner = new DefaultCheckRunner({
      commandRunner,
      taskStore,
      approvalGate: new ApprovalGate(),
      createCheckId: checkIds(),
    });
    const unsafeProject = project({ lint: 'rm -rf /', test: 'pnpm test:unit' });

    const result = await runner.run({ task: task(), step: step(), project: unsafeProject });

    expect(commandRunner.requests).toEqual([
      {
        command: 'pnpm test:unit',
        cwd: '/tmp/forgeroom/worktrees/task-1',
        stdoutPath: '/tmp/forgeroom/worktrees/task-1/.forgeroom/logs/check_test.stdout',
        stderrPath: '/tmp/forgeroom/worktrees/task-1/.forgeroom/logs/check_test.stderr',
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
    ]);
    expect(taskStore.stepPatches).toEqual([
      { id: 'step-row-1', patch: { check_status: 'failed', check_fix_attempt: 0 } },
    ]);
  });
});

function task(): Task {
  return {
    id: 'task-1',
    project_id: 'project-a',
    workflow_id: 'goal-feature',
    title: 'Task 1',
    description: 'Task 1 description',
    status: 'running',
    failure_reason: null,
    source: 'discord-command',
    external_ref: null,
    issue_number: null,
    branch_name: 'forgeroom/task-1',
    worktree_path: '/tmp/forgeroom/worktrees/task-1',
    pr_number: null,
    vars: {},
    created_at: new Date('2026-05-23T00:00:00.000Z'),
    updated_at: new Date('2026-05-23T00:00:00.000Z'),
  };
}

function step(): Step {
  return {
    id: 'step-row-1',
    task_id: 'task-1',
    step_id: 'execute',
    parent_step_id: null,
    iteration: 0,
    agent_id: 'implementer',
    status: 'done',
    failure_reason: null,
    attempt: 0,
    check_fix_attempt: 0,
    check_status: 'not_run',
    prompt_path: '/tmp/forgeroom/worktrees/task-1/.forgeroom/prompts/01_execute.md',
    output_path: '/tmp/forgeroom/worktrees/task-1/.forgeroom/outputs/01_execute.md',
    diff_path: null,
    exit_code: 0,
    started_at: new Date('2026-05-23T00:00:00.000Z'),
    finished_at: new Date('2026-05-23T00:01:00.000Z'),
  };
}

function project(commands: Record<string, string> = { lint: 'pnpm lint', test: 'pnpm test:unit' }): ProjectMeta {
  return {
    id: 'project-a',
    path: '/repo/project-a',
    default_branch: 'main',
    package_manager: 'pnpm',
    default_workflow: 'goal-feature',
    allowed_workflows: ['goal-feature'],
    template_dir: null,
    commands,
    maintainers: { discord_user_ids: [], github_logins: [] },
  };
}
