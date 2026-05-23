import { describe, expect, it } from 'vitest';

import {
  CHECK_STATUSES,
  STEP_STATUSES,
  TASK_STATUSES,
  isTaskStatus,
  type CheckStatus,
  type CheckRunResult,
  type Reporter,
  type ReporterEvent,
  type ReporterSink,
  type StepStatus,
  type TaskStatus,
} from './types.js';

describe('core shared types', () => {
  it('exports the canonical task, step, and check status values from the data model', () => {
    expect(TASK_STATUSES).toEqual(['queued', 'running', 'paused', 'done', 'failed', 'canceled']);
    expect(STEP_STATUSES).toEqual(['pending', 'running', 'paused', 'done', 'failed']);
    expect(CHECK_STATUSES).toEqual(['not_run', 'passed', 'failed', 'fixed']);
  });

  it('narrows task status strings at trust boundaries', () => {
    const status: string = 'running';

    expect(isTaskStatus(status)).toBe(true);
    expect(isTaskStatus('merged')).toBe(false);

    if (isTaskStatus(status)) {
      const narrowed: TaskStatus = status;
      expect(narrowed).toBe('running');
    }
  });

  it('provides exported unions for step and check state machines', () => {
    const stepStatus: StepStatus = 'paused';
    const checkStatus: CheckStatus = 'fixed';

    expect(stepStatus).toBe('paused');
    expect(checkStatus).toBe('fixed');
  });

  it('exports check and reporter contracts shared by later modules', async () => {
    const task = makeTask();
    const checkResult: CheckRunResult = {
      allPassed: false,
      results: [
        {
          commandName: 'test',
          command: 'pnpm test:unit',
          exitCode: 1,
          durationMs: 120,
          stdoutPath: '/tmp/stdout',
          stderrPath: '/tmp/stderr',
        },
      ],
    };
    const event: ReporterEvent = { type: 'check_result', task, results: checkResult.results };
    const delivered: ReporterEvent[] = [];
    const sink: ReporterSink = {
      destination: 'discord',
      deliver: (request) => {
        delivered.push(request.event);
        return Promise.resolve({ surface: request.surface });
      },
    };
    const reporter: Reporter = {
      notify: async (reporterEvent) => {
        await sink.deliver({ event: reporterEvent, surface: null });
      },
      flushUndelivered: () => Promise.resolve(),
    };

    await reporter.notify(event);

    expect(checkResult.allPassed).toBe(false);
    expect(delivered).toEqual([event]);
  });
});

function makeTask() {
  return {
    id: 'task-1',
    project_id: 'project',
    workflow_id: 'quick',
    title: 'Implement feature',
    description: 'Task description',
    status: 'running',
    failure_reason: null,
    source: 'discord-command',
    external_ref: null,
    issue_number: null,
    branch_name: 'agent/project-task',
    worktree_path: '/tmp/worktree',
    pr_number: null,
    final_slices: [] as string[],
    vars: {},
    mastra_run_id: null,
    created_at: new Date('2026-05-22T00:00:00.000Z'),
    updated_at: new Date('2026-05-22T00:00:00.000Z'),
  } as const;
}
