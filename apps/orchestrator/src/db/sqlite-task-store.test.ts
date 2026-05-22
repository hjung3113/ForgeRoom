import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TaskStore } from '../core/task-store';
import type { OrchestratorFailureCode } from '../core/errors';
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
    vi.useRealTimers();
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

  it('upserts conductor state and refreshes the last updated timestamp', async () => {
    await store.createTask(taskInput('task-conductor-state', 'project-a', 'queued'));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T13:20:00.000Z'));

    await store.upsertConductorState(
      'task-conductor-state',
      'Initial summary',
      '/tmp/forgeroom/context/summary.md',
      null,
    );
    const inserted = await store.getConductorState('task-conductor-state');

    expect(inserted).toMatchObject({
      task_id: 'task-conductor-state',
      summary: 'Initial summary',
      summary_path: '/tmp/forgeroom/context/summary.md',
      last_step_id: null,
    });
    expect(inserted?.last_updated).toEqual(new Date('2026-05-22T13:20:00.000Z'));

    vi.setSystemTime(new Date('2026-05-22T13:21:00.000Z'));
    await store.upsertConductorState(
      'task-conductor-state',
      'Updated summary',
      '/tmp/forgeroom/context/summary-v2.md',
      'step-conductor',
    );

    await expect(store.getConductorState('task-conductor-state')).resolves.toMatchObject({
      task_id: 'task-conductor-state',
      summary: 'Updated summary',
      summary_path: '/tmp/forgeroom/context/summary-v2.md',
      last_step_id: 'step-conductor',
      last_updated: new Date('2026-05-22T13:21:00.000Z'),
    });

    vi.setSystemTime(new Date('2026-05-22T13:22:00.000Z'));
    await store.upsertConductorState(
      'task-conductor-state',
      'Summary-only refresh',
      '/tmp/forgeroom/context/summary-v3.md',
    );

    await expect(store.getConductorState('task-conductor-state')).resolves.toMatchObject({
      task_id: 'task-conductor-state',
      summary: 'Summary-only refresh',
      summary_path: '/tmp/forgeroom/context/summary-v3.md',
      last_step_id: 'step-conductor',
      last_updated: new Date('2026-05-22T13:22:00.000Z'),
    });
  });

  it('marks user feedback events as applied without losing payload fields', async () => {
    await store.createTask(taskInput('task-user-feedback', 'project-a', 'queued'));
    await store.enqueueEvent({
      id: 'event-user-feedback',
      task_id: 'task-user-feedback',
      type: 'user_feedback',
      payload: {
        message: 'Please keep the local-only MVP boundary.',
        author: 'hyojung',
        channel_id: 'discord-channel-1',
      },
      created_at: new Date('2026-05-22T13:30:00.000Z'),
    });

    await store.markUserFeedbackApplied(
      'event-user-feedback',
      new Date('2026-05-22T13:45:00.000Z'),
    );

    await expect(store.getEvent('event-user-feedback')).resolves.toMatchObject({
      id: 'event-user-feedback',
      type: 'user_feedback',
      payload: {
        message: 'Please keep the local-only MVP boundary.',
        author: 'hyojung',
        channel_id: 'discord-channel-1',
        applied_at: '2026-05-22T13:45:00.000Z',
      },
    });
  });

  it('persists canonical failure reasons and external status identifiers through public reads', async () => {
    await store.createTask({
      ...taskInput('task-status-persistence', 'project-a', 'failed'),
      failure_reason: 'check_failed_after_fix',
      external_ref: {
        provider: 'github',
        id: '42',
        url: 'https://github.example.test/owner/repo/issues/42',
        status_comment_id: 'comment-42',
        status_message_id: 'message-42',
      },
    });
    await store.createStep({
      ...stepInput('step-status-persistence', 'task-status-persistence'),
      status: 'failed',
      failure_reason: 'check_failed_after_fix',
    });

    await expect(store.getTask('task-status-persistence')).resolves.toMatchObject({
      id: 'task-status-persistence',
      status: 'failed',
      failure_reason: 'check_failed_after_fix',
      external_ref: {
        provider: 'github',
        id: '42',
        url: 'https://github.example.test/owner/repo/issues/42',
        status_comment_id: 'comment-42',
        status_message_id: 'message-42',
      },
    });
    await expect(store.listSteps('task-status-persistence')).resolves.toMatchObject([
      {
        id: 'step-status-persistence',
        status: 'failed',
        failure_reason: 'check_failed_after_fix',
      },
    ]);
    await expect(
      store.createTask({
        ...taskInput('task-invalid-failure', 'project-a', 'failed'),
        failure_reason: 'not_canonical' as unknown as OrchestratorFailureCode,
      }),
    ).rejects.toThrow(/invalid failure_reason/i);
    await expect(
      store.updateStep('step-status-persistence', {
        failure_reason: 'not_canonical' as unknown as OrchestratorFailureCode,
      }),
    ).rejects.toThrow(/invalid failure_reason/i);
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

  it('rolls back task creation when starting a task cannot acquire the project lock', async () => {
    await store.startTask(taskInput('winner', 'project-a', 'queued'));

    await expect(store.startTask(taskInput('loser', 'project-a', 'queued'))).rejects.toThrow(
      /active task/i,
    );

    await expect(store.getTask('loser')).resolves.toBeNull();
    expect(database.sqlite.prepare('select count(*) as count from tasks where id = ?').get('loser')).toEqual({
      count: 0,
    });
  });

  it('rolls back step completion when the step_done event cannot be inserted', async () => {
    await store.createTask(taskInput('task-step-transaction', 'project-a', 'queued'));
    await store.createStep(stepInput('step-transaction', 'task-step-transaction'));
    await store.enqueueEvent({
      id: 'duplicate-step-event',
      task_id: 'task-step-transaction',
      type: 'step_done',
      payload: { step_id: 'existing' },
      created_at: new Date('2026-05-22T17:00:00.000Z'),
    });

    await expect(
      store.completeStepWithEvent(
        'step-transaction',
        {
          status: 'done',
          finished_at: new Date('2026-05-22T17:01:00.000Z'),
          exit_code: 0,
        },
        {
          id: 'duplicate-step-event',
          task_id: 'task-step-transaction',
          type: 'step_done',
          payload: { step_id: 'execute', status: 'done' },
          created_at: new Date('2026-05-22T17:01:00.000Z'),
        },
      ),
    ).rejects.toThrow(/unique constraint/i);

    await expect(store.listSteps('task-step-transaction')).resolves.toMatchObject([
      {
        id: 'step-transaction',
        status: 'running',
        finished_at: null,
        exit_code: null,
      },
    ]);
  });

  it('cancels a task with a task_canceled event and releases the project lock', async () => {
    await store.startTask(taskInput('task-cancel', 'project-a', 'queued'));
    await store.createTask(taskInput('task-after-cancel', 'project-a', 'queued'));

    await store.cancelTask('task-cancel', 'event-task-canceled', { reason: 'user_request' });

    await expect(store.getTask('task-cancel')).resolves.toMatchObject({
      id: 'task-cancel',
      status: 'canceled',
    });
    expect(
      database.sqlite
        .prepare('select id, task_id, type, payload from events where id = ?')
        .get('event-task-canceled'),
    ).toEqual({
      id: 'event-task-canceled',
      task_id: 'task-cancel',
      type: 'task_canceled',
      payload: JSON.stringify({ reason: 'user_request' }),
    });
    await expect(store.acquireProjectLock('project-a', 'task-after-cancel')).resolves.toBe(true);
    await expect(store.getTask('task-after-cancel')).resolves.toMatchObject({
      id: 'task-after-cancel',
      status: 'running',
    });
  });

  it('rolls back task cancellation when the task_canceled event cannot be inserted', async () => {
    await store.startTask(taskInput('task-cancel-rollback', 'project-a', 'queued'));
    await store.createTask(taskInput('task-blocked-by-rollback', 'project-a', 'queued'));
    await store.enqueueEvent({
      id: 'duplicate-cancel-event',
      task_id: 'task-cancel-rollback',
      type: 'task_canceled',
      payload: { reason: 'existing' },
      created_at: new Date('2026-05-22T17:05:00.000Z'),
    });

    await expect(
      store.cancelTask('task-cancel-rollback', 'duplicate-cancel-event', { reason: 'user_request' }),
    ).rejects.toThrow(/unique constraint/i);

    await expect(store.getTask('task-cancel-rollback')).resolves.toMatchObject({
      id: 'task-cancel-rollback',
      status: 'running',
    });
    await expect(store.acquireProjectLock('project-a', 'task-blocked-by-rollback')).resolves.toBe(false);
    await expect(store.getTask('task-blocked-by-rollback')).resolves.toMatchObject({
      id: 'task-blocked-by-rollback',
      status: 'queued',
    });
  });
});

function taskInput(
  id: string,
  projectId: string,
  status: 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'canceled' = 'queued',
) {
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

function stepInput(id: string, taskId: string) {
  return {
    id,
    task_id: taskId,
    step_id: 'execute',
    parent_step_id: null,
    iteration: 0,
    agent_id: 'implementer',
    status: 'running' as const,
    failure_reason: null,
    attempt: 0,
    check_fix_attempt: 0,
    check_status: 'not_run' as const,
    prompt_path: `/tmp/forgeroom/prompts/${id}.md`,
    output_path: `/tmp/forgeroom/outputs/${id}.md`,
    diff_path: null,
    exit_code: null,
    started_at: new Date('2026-05-22T17:00:00.000Z'),
    finished_at: null,
  };
}
