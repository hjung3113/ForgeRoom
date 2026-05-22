import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TaskStore } from '../core/task-store';
import { createTaskStoreDatabase, migrateTaskStoreDatabase, type TaskStoreDatabase } from './client';
import { SqliteTaskStore } from './sqlite-task-store';

describe('SqliteTaskStore', () => {
  let database: TaskStoreDatabase;
  let store: TaskStore;

  beforeEach(() => {
    database = createTaskStoreDatabase(':memory:');
    migrateTaskStoreDatabase(database);
    store = new SqliteTaskStore(database);
  });

  afterEach(() => {
    database.close();
  });

  it('migrates the tasks table and preserves task JSON fields', async () => {
    const task = await store.createTask({
      id: 'task-json',
      project_id: 'project-a',
      workflow_id: 'workflow-main',
      title: 'Implement JSON preservation',
      description: 'Persist external references and vars.',
      status: 'queued',
      source: 'discord-command',
      external_ref: {
        provider: 'discord',
        id: 'message-1',
        url: 'https://example.test/message-1',
        title: 'Original title',
        status_comment_id: 'comment-1',
        status_message_id: 'status-1',
      },
      issue_number: null,
      branch_name: 'forgeroom/task-json',
      worktree_path: '/tmp/forgeroom/task-json',
      pr_number: null,
      vars: {
        priority: 'high',
        requester: 'hyojung',
      },
    });

    const table = database.sqlite
      .prepare("select name from sqlite_master where type = 'table' and name = 'tasks'")
      .get();
    expect(table).toEqual({ name: 'tasks' });
    expect(
      database.sqlite
        .prepare("select name from forgeroom_migrations where name = '0001_initial.sql'")
        .get(),
    ).toEqual({ name: '0001_initial.sql' });

    await expect(store.getTask(task.id)).resolves.toMatchObject({
      id: 'task-json',
      external_ref: {
        provider: 'discord',
        id: 'message-1',
        url: 'https://example.test/message-1',
        title: 'Original title',
        status_comment_id: 'comment-1',
        status_message_id: 'status-1',
      },
      vars: {
        priority: 'high',
        requester: 'hyojung',
      },
    });
  });

  it('enforces at most one active task per project while allowing queued and done tasks', async () => {
    await store.createTask(taskInput('queued-1', 'project-a', 'queued'));
    await store.createTask(taskInput('done-1', 'project-a', 'done'));
    await store.createTask(taskInput('running-1', 'project-a', 'running'));

    await expect(store.createTask(taskInput('paused-1', 'project-a', 'paused'))).rejects.toThrow(
      /active task/i,
    );

    await expect(
      store.createTask(taskInput('running-other-project', 'project-b', 'running')),
    ).resolves.toMatchObject({
      id: 'running-other-project',
      project_id: 'project-b',
    });
  });

  it('acquires a project lock only when no other active task exists', async () => {
    await store.createTask(taskInput('queued-1', 'project-a', 'queued'));
    await store.createTask(taskInput('queued-2', 'project-a', 'queued'));

    await expect(store.acquireProjectLock('project-a', 'queued-1')).resolves.toBe(true);
    await expect(store.acquireProjectLock('project-a', 'queued-2')).resolves.toBe(false);

    await store.updateTaskStatus('queued-1', 'done');
    await expect(store.acquireProjectLock('project-a', 'queued-2')).resolves.toBe(true);
  });

  it('creates and lists steps with all data-model fields ordered by started_at', async () => {
    await store.createTask(taskInput('task-steps', 'project-a', 'queued'));
    const laterStartedAt = new Date('2026-05-22T10:02:00.000Z');
    const earlierStartedAt = new Date('2026-05-22T10:01:00.000Z');
    const finishedAt = new Date('2026-05-22T10:03:00.000Z');

    await store.createStep({
      id: 'step-parent',
      task_id: 'task-steps',
      step_id: 'review_loop',
      parent_step_id: null,
      iteration: 0,
      agent_id: 'conductor',
      status: 'running',
      failure_reason: null,
      attempt: 0,
      check_fix_attempt: 0,
      check_status: 'not_run',
      prompt_path: '/tmp/forgeroom/prompts/review-loop.md',
      output_path: '/tmp/forgeroom/outputs/review-loop.md',
      diff_path: null,
      exit_code: null,
      started_at: earlierStartedAt,
      finished_at: null,
    });
    await store.createStep({
      id: 'step-child',
      task_id: 'task-steps',
      step_id: 'execute',
      parent_step_id: 'step-parent',
      iteration: 2,
      agent_id: 'implementer',
      status: 'done',
      failure_reason: null,
      attempt: 1,
      check_fix_attempt: 1,
      check_status: 'fixed',
      prompt_path: '/tmp/forgeroom/prompts/execute.md',
      output_path: '/tmp/forgeroom/outputs/execute.md',
      diff_path: '/tmp/forgeroom/diffs/execute.patch',
      exit_code: 0,
      started_at: laterStartedAt,
      finished_at: finishedAt,
    });

    await expect(
      store.createStep({
        id: 'step-orphan',
        task_id: 'task-steps',
        step_id: 'execute',
        parent_step_id: 'missing-parent',
        iteration: 2,
        agent_id: 'implementer',
        status: 'done',
        failure_reason: null,
        attempt: 1,
        check_fix_attempt: 1,
        check_status: 'fixed',
        prompt_path: '/tmp/forgeroom/prompts/execute.md',
        output_path: '/tmp/forgeroom/outputs/execute.md',
        diff_path: '/tmp/forgeroom/diffs/execute.patch',
        exit_code: 0,
        started_at: laterStartedAt,
        finished_at: finishedAt,
      }),
    ).rejects.toThrow(/foreign key/i);

    await expect(store.listSteps('task-steps')).resolves.toEqual([
      {
        id: 'step-parent',
        task_id: 'task-steps',
        step_id: 'review_loop',
        parent_step_id: null,
        iteration: 0,
        agent_id: 'conductor',
        status: 'running',
        failure_reason: null,
        attempt: 0,
        check_fix_attempt: 0,
        check_status: 'not_run',
        prompt_path: '/tmp/forgeroom/prompts/review-loop.md',
        output_path: '/tmp/forgeroom/outputs/review-loop.md',
        diff_path: null,
        exit_code: null,
        started_at: earlierStartedAt,
        finished_at: null,
      },
      {
        id: 'step-child',
        task_id: 'task-steps',
        step_id: 'execute',
        parent_step_id: 'step-parent',
        iteration: 2,
        agent_id: 'implementer',
        status: 'done',
        failure_reason: null,
        attempt: 1,
        check_fix_attempt: 1,
        check_status: 'fixed',
        prompt_path: '/tmp/forgeroom/prompts/execute.md',
        output_path: '/tmp/forgeroom/outputs/execute.md',
        diff_path: '/tmp/forgeroom/diffs/execute.patch',
        exit_code: 0,
        started_at: laterStartedAt,
        finished_at: finishedAt,
      },
    ]);
  });

  it('updates selected step fields without clobbering unchanged fields', async () => {
    await store.createTask(taskInput('task-update-step', 'project-a', 'queued'));
    const startedAt = new Date('2026-05-22T11:00:00.000Z');
    const finishedAt = new Date('2026-05-22T11:05:00.000Z');
    await store.createStep({
      id: 'step-update',
      task_id: 'task-update-step',
      step_id: 'execute',
      parent_step_id: null,
      iteration: 0,
      agent_id: 'implementer',
      status: 'running',
      failure_reason: null,
      attempt: 0,
      check_fix_attempt: 0,
      check_status: 'not_run',
      prompt_path: '/tmp/forgeroom/prompts/execute.md',
      output_path: '/tmp/forgeroom/outputs/execute.md',
      diff_path: null,
      exit_code: null,
      started_at: startedAt,
      finished_at: null,
    });

    await store.updateStep('step-update', {
      status: 'failed',
      failure_reason: 'check_failed_after_fix',
      attempt: 2,
      check_fix_attempt: 1,
      check_status: 'failed',
      diff_path: '/tmp/forgeroom/diffs/execute.patch',
      exit_code: 1,
      finished_at: finishedAt,
    });

    await expect(store.listSteps('task-update-step')).resolves.toEqual([
      {
        id: 'step-update',
        task_id: 'task-update-step',
        step_id: 'execute',
        parent_step_id: null,
        iteration: 0,
        agent_id: 'implementer',
        status: 'failed',
        failure_reason: 'check_failed_after_fix',
        attempt: 2,
        check_fix_attempt: 1,
        check_status: 'failed',
        prompt_path: '/tmp/forgeroom/prompts/execute.md',
        output_path: '/tmp/forgeroom/outputs/execute.md',
        diff_path: '/tmp/forgeroom/diffs/execute.patch',
        exit_code: 1,
        started_at: startedAt,
        finished_at: finishedAt,
      },
    ]);
  });

  it('records check rows append-only by check_fix_attempt', async () => {
    await store.createTask(taskInput('task-checks', 'project-a', 'queued'));
    await store.createStep({
      id: 'step-checks',
      task_id: 'task-checks',
      step_id: 'execute',
      parent_step_id: null,
      iteration: 0,
      agent_id: 'implementer',
      status: 'done',
      failure_reason: null,
      attempt: 0,
      check_fix_attempt: 1,
      check_status: 'fixed',
      prompt_path: '/tmp/forgeroom/prompts/execute.md',
      output_path: '/tmp/forgeroom/outputs/execute.md',
      diff_path: '/tmp/forgeroom/diffs/execute.patch',
      exit_code: 0,
      started_at: new Date('2026-05-22T12:00:00.000Z'),
      finished_at: new Date('2026-05-22T12:01:00.000Z'),
    });

    await expect(
      store.recordCheck({
        id: 'check-attempt-0',
        step_row_id: 'step-checks',
        check_fix_attempt: 0,
        command_name: 'test',
        command: 'pnpm test',
        exit_code: 1,
        stdout_path: '/tmp/forgeroom/logs/test-0.stdout.log',
        stderr_path: '/tmp/forgeroom/logs/test-0.stderr.log',
        duration_ms: 1200,
      }),
    ).resolves.toMatchObject({
      id: 'check-attempt-0',
      step_row_id: 'step-checks',
      check_fix_attempt: 0,
      exit_code: 1,
      stdout_path: '/tmp/forgeroom/logs/test-0.stdout.log',
      stderr_path: '/tmp/forgeroom/logs/test-0.stderr.log',
      duration_ms: 1200,
    });
    await store.recordCheck({
      id: 'check-attempt-1',
      step_row_id: 'step-checks',
      check_fix_attempt: 1,
      command_name: 'test',
      command: 'pnpm test',
      exit_code: 0,
      stdout_path: '/tmp/forgeroom/logs/test-1.stdout.log',
      stderr_path: '/tmp/forgeroom/logs/test-1.stderr.log',
      duration_ms: 900,
    });

    expect(
      database.sqlite
        .prepare(
          `select id, step_row_id, check_fix_attempt, command_name, command, exit_code, stdout_path, stderr_path, duration_ms
           from checks
           where step_row_id = ?
           order by check_fix_attempt`,
        )
        .all('step-checks'),
    ).toEqual([
      {
        id: 'check-attempt-0',
        step_row_id: 'step-checks',
        check_fix_attempt: 0,
        command_name: 'test',
        command: 'pnpm test',
        exit_code: 1,
        stdout_path: '/tmp/forgeroom/logs/test-0.stdout.log',
        stderr_path: '/tmp/forgeroom/logs/test-0.stderr.log',
        duration_ms: 1200,
      },
      {
        id: 'check-attempt-1',
        step_row_id: 'step-checks',
        check_fix_attempt: 1,
        command_name: 'test',
        command: 'pnpm test',
        exit_code: 0,
        stdout_path: '/tmp/forgeroom/logs/test-1.stdout.log',
        stderr_path: '/tmp/forgeroom/logs/test-1.stderr.log',
        duration_ms: 900,
      },
    ]);
  });

  it('persists event payload JSON and allows multiple destination deliveries for one event', async () => {
    await store.createTask(taskInput('task-events', 'project-a', 'queued'));

    const event = await store.enqueueEvent({
      id: 'event-step-done',
      task_id: 'task-events',
      type: 'step_done',
      payload: {
        step_id: 'execute',
        result: 'done',
        nested: { changed_files: ['apps/orchestrator/src/db/sqlite-task-store.ts'] },
      },
      created_at: new Date('2026-05-22T13:00:00.000Z'),
    });
    const discordDelivery = await store.enqueueEventDelivery({
      id: 'delivery-discord',
      event_id: event.id,
      destination: 'discord',
      created_at: new Date('2026-05-22T13:00:01.000Z'),
    });
    const githubDelivery = await store.enqueueEventDelivery({
      id: 'delivery-github',
      event_id: event.id,
      destination: 'github',
      created_at: new Date('2026-05-22T13:00:02.000Z'),
    });

    expect(discordDelivery).toMatchObject({
      id: 'delivery-discord',
      event_id: 'event-step-done',
      destination: 'discord',
      delivery_attempts: 0,
      next_delivery_at: null,
      last_delivery_error: null,
      delivered_at: null,
    });
    expect(githubDelivery).toMatchObject({
      id: 'delivery-github',
      event_id: 'event-step-done',
      destination: 'github',
    });
    const deliveryPayloadRows = database.sqlite
      .prepare(
        `select d.id as delivery_id, d.destination, e.id as event_id, e.payload
         from event_deliveries d
         join events e on e.id = d.event_id
         where e.id = ?
         order by d.destination`,
      )
      .all('event-step-done') as Array<{
      delivery_id: string;
      destination: string;
      event_id: string;
      payload: string;
    }>;

    expect(
      deliveryPayloadRows.map((row) => ({
        ...row,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
      })),
    ).toEqual([
      {
        delivery_id: 'delivery-discord',
        destination: 'discord',
        event_id: 'event-step-done',
        payload: {
          step_id: 'execute',
          result: 'done',
          nested: { changed_files: ['apps/orchestrator/src/db/sqlite-task-store.ts'] },
        },
      },
      {
        delivery_id: 'delivery-github',
        destination: 'github',
        event_id: 'event-step-done',
        payload: {
          step_id: 'execute',
          result: 'done',
          nested: { changed_files: ['apps/orchestrator/src/db/sqlite-task-store.ts'] },
        },
      },
    ]);
  });

  it('lists only due undelivered deliveries in a predictable order', async () => {
    await store.createTask(taskInput('task-due-deliveries', 'project-a', 'queued'));
    await store.enqueueEvent({
      id: 'event-due',
      task_id: 'task-due-deliveries',
      type: 'task_started',
      payload: { status: 'running' },
      created_at: new Date('2026-05-22T14:00:00.000Z'),
    });
    await store.enqueueEventDelivery({
      id: 'delivery-no-next',
      event_id: 'event-due',
      destination: 'discord',
      created_at: new Date('2026-05-22T14:00:01.000Z'),
    });
    await store.enqueueEventDelivery({
      id: 'delivery-past-next',
      event_id: 'event-due',
      destination: 'github',
      next_delivery_at: new Date('2026-05-22T14:02:00.000Z'),
      created_at: new Date('2026-05-22T14:00:02.000Z'),
    });
    await store.enqueueEventDelivery({
      id: 'delivery-future-next',
      event_id: 'event-due',
      destination: 'discord',
      next_delivery_at: new Date('2026-05-22T14:10:00.000Z'),
      created_at: new Date('2026-05-22T14:00:03.000Z'),
    });
    await store.enqueueEventDelivery({
      id: 'delivery-delivered',
      event_id: 'event-due',
      destination: 'github',
      next_delivery_at: new Date('2026-05-22T14:01:00.000Z'),
      delivered_at: new Date('2026-05-22T14:03:00.000Z'),
      created_at: new Date('2026-05-22T14:00:04.000Z'),
    });

    await expect(
      store.listDueUndeliveredDeliveries(new Date('2026-05-22T14:05:00.000Z')),
    ).resolves.toMatchObject([
      {
        id: 'delivery-no-next',
        event_id: 'event-due',
        delivered_at: null,
        next_delivery_at: null,
      },
      {
        id: 'delivery-past-next',
        event_id: 'event-due',
        delivered_at: null,
        next_delivery_at: new Date('2026-05-22T14:02:00.000Z'),
      },
    ]);
  });

  it('marks deliveries delivered and excludes them from due delivery lookup', async () => {
    await store.createTask(taskInput('task-delivered', 'project-a', 'queued'));
    await store.enqueueEvent({
      id: 'event-delivered',
      task_id: 'task-delivered',
      type: 'task_started',
      payload: { status: 'running' },
      created_at: new Date('2026-05-22T15:00:00.000Z'),
    });
    await store.enqueueEventDelivery({
      id: 'delivery-to-mark',
      event_id: 'event-delivered',
      destination: 'discord',
      created_at: new Date('2026-05-22T15:00:01.000Z'),
    });

    await expect(
      store.listDueUndeliveredDeliveries(new Date('2026-05-22T15:01:00.000Z')),
    ).resolves.toHaveLength(1);
    await store.markDeliveryDelivered('delivery-to-mark');

    await expect(
      store.listDueUndeliveredDeliveries(new Date('2026-05-22T15:01:00.000Z')),
    ).resolves.toEqual([]);
    const deliveredRow = database.sqlite
      .prepare('select delivered_at from event_deliveries where id = ?')
      .get('delivery-to-mark') as { delivered_at: string } | undefined;
    expect(typeof deliveredRow?.delivered_at).toBe('string');
  });

  it('persists failed delivery retry fields', async () => {
    await store.createTask(taskInput('task-failed-delivery', 'project-a', 'queued'));
    await store.enqueueEvent({
      id: 'event-failed-delivery',
      task_id: 'task-failed-delivery',
      type: 'task_failed',
      payload: { failure_reason: 'check_failed_after_fix' },
      created_at: new Date('2026-05-22T16:00:00.000Z'),
    });
    await store.enqueueEventDelivery({
      id: 'delivery-failed',
      event_id: 'event-failed-delivery',
      destination: 'github',
      created_at: new Date('2026-05-22T16:00:01.000Z'),
    });

    await store.markDeliveryFailed('delivery-failed', {
      delivery_attempts: 2,
      next_delivery_at: new Date('2026-05-22T16:05:00.000Z'),
      last_delivery_error: 'GitHub API rate limit',
    });

    await expect(
      store.listDueUndeliveredDeliveries(new Date('2026-05-22T16:04:59.000Z')),
    ).resolves.toEqual([]);
    await expect(
      store.listDueUndeliveredDeliveries(new Date('2026-05-22T16:05:00.000Z')),
    ).resolves.toMatchObject([
      {
        id: 'delivery-failed',
        delivery_attempts: 2,
        next_delivery_at: new Date('2026-05-22T16:05:00.000Z'),
        last_delivery_error: 'GitHub API rate limit',
        delivered_at: null,
      },
    ]);
  });
});

function taskInput(id: string, projectId: string, status: 'queued' | 'running' | 'paused' | 'done') {
  return {
    id,
    project_id: projectId,
    workflow_id: 'workflow-main',
    title: `Task ${id}`,
    description: `Description for ${id}`,
    status,
    source: 'discord-command' as const,
    external_ref: null,
    issue_number: null,
    branch_name: `forgeroom/${id}`,
    worktree_path: `/tmp/forgeroom/${id}`,
    pr_number: null,
    vars: {},
  };
}
