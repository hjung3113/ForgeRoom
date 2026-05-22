import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

import type { CheckStatus, ExternalRef, StepStatus, TaskSource, TaskStatus } from '../core/types';

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    workflowId: text('workflow_id').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    status: text('status').$type<TaskStatus>().notNull(),
    failureReason: text('failure_reason'),
    source: text('source').$type<TaskSource>().notNull(),
    externalRef: text('external_ref', { mode: 'json' }).$type<ExternalRef | null>(),
    issueNumber: integer('issue_number'),
    branchName: text('branch_name').notNull(),
    worktreePath: text('worktree_path').notNull(),
    prNumber: integer('pr_number'),
    vars: text('vars', { mode: 'json' }).$type<Record<string, string>>().notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('tasks_project_status_idx').on(table.projectId, table.status),
    uniqueIndex('tasks_one_active_per_project_idx')
      .on(table.projectId)
      .where(sql`${table.status} in ('running', 'paused')`),
  ],
);

export const steps = sqliteTable(
  'steps',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    stepId: text('step_id').notNull(),
    parentStepId: text('parent_step_id').references((): AnySQLiteColumn => steps.id),
    iteration: integer('iteration').notNull().default(0),
    agentId: text('agent_id').notNull(),
    status: text('status').$type<StepStatus>().notNull(),
    failureReason: text('failure_reason'),
    attempt: integer('attempt').notNull().default(0),
    checkFixAttempt: integer('check_fix_attempt').notNull().default(0),
    checkStatus: text('check_status').$type<CheckStatus>().notNull().default('not_run'),
    promptPath: text('prompt_path').notNull(),
    outputPath: text('output_path').notNull(),
    diffPath: text('diff_path'),
    exitCode: integer('exit_code'),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (table) => [index('steps_task_started_idx').on(table.taskId, table.startedAt)],
);

export const checks = sqliteTable('checks', {
  id: text('id').primaryKey(),
  stepRowId: text('step_row_id')
    .notNull()
    .references(() => steps.id, { onDelete: 'cascade' }),
  checkFixAttempt: integer('check_fix_attempt').notNull(),
  commandName: text('command_name').notNull(),
  command: text('command').notNull(),
  exitCode: integer('exit_code').notNull(),
  stdoutPath: text('stdout_path').notNull(),
  stderrPath: text('stderr_path').notNull(),
  durationMs: integer('duration_ms').notNull(),
  createdAt: text('created_at').notNull(),
});

export const events = sqliteTable('events', {
  id: text('id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  createdAt: text('created_at').notNull(),
});

export const eventDeliveries = sqliteTable(
  'event_deliveries',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    destination: text('destination').$type<'discord' | 'github'>().notNull(),
    deliveryAttempts: integer('delivery_attempts').notNull().default(0),
    nextDeliveryAt: text('next_delivery_at'),
    lastDeliveryError: text('last_delivery_error'),
    deliveredAt: text('delivered_at'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('event_deliveries_due_idx')
      .on(table.deliveredAt, table.nextDeliveryAt)
      .where(sql`${table.deliveredAt} is null`),
  ],
);

export const conductorState = sqliteTable('conductor_state', {
  taskId: text('task_id')
    .primaryKey()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  summary: text('summary').notNull(),
  lastStepId: text('last_step_id'),
  summaryPath: text('summary_path').notNull(),
  lastUpdated: text('last_updated').notNull(),
});
