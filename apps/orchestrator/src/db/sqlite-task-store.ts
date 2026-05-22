import { and, asc, eq, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { CreateCheckInput, CreateStepInput, CreateTaskInput, TaskStore } from '../core/task-store';
import type { Check, Step, Task, TaskStatus } from '../core/types';
import type { TaskStoreDatabase } from './client';
import * as schema from './schema';
import { checks, steps, tasks } from './schema';

type Database = BetterSQLite3Database<typeof schema>;
type StepRow = typeof steps.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;

export class SqliteTaskStore implements TaskStore {
  private readonly db: Database;

  constructor(database: TaskStoreDatabase | Database) {
    this.db = 'db' in database ? database.db : database;
  }

  createTask(input: CreateTaskInput): Promise<Task> {
    const now = new Date();
    const task: Task = {
      ...input,
      failure_reason: input.failure_reason ?? null,
      created_at: now,
      updated_at: now,
    };

    try {
      this.db.insert(tasks).values(toTaskRow(task)).run();
    } catch (error) {
      return Promise.reject(toTaskStoreError(error));
    }

    return Promise.resolve(task);
  }

  updateTaskStatus(id: string, status: TaskStatus): Promise<void> {
    try {
      this.db
        .update(tasks)
        .set({ status, updatedAt: new Date().toISOString() })
        .where(eq(tasks.id, id))
        .run();
    } catch (error) {
      return Promise.reject(toTaskStoreError(error));
    }
    return Promise.resolve();
  }

  getTask(id: string): Promise<Task | null> {
    const row = this.db.select().from(tasks).where(eq(tasks.id, id)).get();
    return Promise.resolve(row === undefined ? null : fromTaskRow(row));
  }

  listActiveTasks(projectId?: string): Promise<Task[]> {
    const activeStatuses = ['running', 'paused'] as const;
    const rows =
      projectId === undefined
        ? this.db
            .select()
            .from(tasks)
            .where(inArray(tasks.status, activeStatuses))
            .orderBy(asc(tasks.createdAt))
            .all()
        : this.db
            .select()
            .from(tasks)
            .where(and(eq(tasks.projectId, projectId), inArray(tasks.status, activeStatuses)))
            .orderBy(asc(tasks.createdAt))
            .all();

    return Promise.resolve(rows.map(fromTaskRow));
  }

  async acquireProjectLock(projectId: string, taskId: string): Promise<boolean> {
    const task = await this.getTask(taskId);
    if (task === null || task.project_id !== projectId || isTerminalStatus(task.status)) {
      return false;
    }
    if (task.status === 'running' || task.status === 'paused') {
      return true;
    }

    try {
      await this.updateTaskStatus(taskId, 'running');
      const lockedTask = await this.getTask(taskId);
      return lockedTask?.project_id === projectId && lockedTask.status === 'running';
    } catch (error) {
      if (isActiveTaskConflict(error)) {
        return false;
      }
      throw error;
    }
  }

  async releaseProjectLock(projectId: string, taskId: string): Promise<void> {
    const task = await this.getTask(taskId);
    if (task !== null && task.project_id === projectId && isActiveStatus(task.status)) {
      await this.updateTaskStatus(taskId, 'queued');
    }
  }

  createStep(input: CreateStepInput): Promise<Step> {
    try {
      this.db.insert(steps).values(toStepRow(input)).run();
    } catch (error) {
      return Promise.reject(toTaskStoreError(error));
    }
    return Promise.resolve(input);
  }

  updateStep(id: string, patch: Partial<Step>): Promise<void> {
    const rowPatch = toStepPatch(patch);
    if (Object.keys(rowPatch).length === 0) {
      return Promise.resolve();
    }

    try {
      this.db.update(steps).set(rowPatch).where(eq(steps.id, id)).run();
    } catch (error) {
      return Promise.reject(toTaskStoreError(error));
    }
    return Promise.resolve();
  }

  listSteps(taskId: string): Promise<Step[]> {
    const rows = this.db
      .select()
      .from(steps)
      .where(eq(steps.taskId, taskId))
      .orderBy(asc(steps.startedAt))
      .all();

    return Promise.resolve(rows.map(fromStepRow));
  }

  recordCheck(input: CreateCheckInput): Promise<Check> {
    const check: Check = {
      ...input,
      created_at: input.created_at ?? new Date(),
    };

    try {
      this.db.insert(checks).values(toCheckRow(check)).run();
    } catch (error) {
      return Promise.reject(toTaskStoreError(error));
    }

    return Promise.resolve(check);
  }
}

export { SqliteTaskStore as SQLiteTaskStore };

function toTaskRow(task: Task): typeof tasks.$inferInsert {
  return {
    id: task.id,
    projectId: task.project_id,
    workflowId: task.workflow_id,
    title: task.title,
    description: task.description,
    status: task.status,
    failureReason: task.failure_reason,
    source: task.source,
    externalRef: task.external_ref,
    issueNumber: task.issue_number,
    branchName: task.branch_name,
    worktreePath: task.worktree_path,
    prNumber: task.pr_number,
    vars: task.vars,
    createdAt: task.created_at.toISOString(),
    updatedAt: task.updated_at.toISOString(),
  };
}

function fromTaskRow(row: TaskRow): Task {
  return {
    id: row.id,
    project_id: row.projectId,
    workflow_id: row.workflowId,
    title: row.title,
    description: row.description,
    status: row.status,
    failure_reason: row.failureReason,
    source: row.source,
    external_ref: row.externalRef,
    issue_number: row.issueNumber,
    branch_name: row.branchName,
    worktree_path: row.worktreePath,
    pr_number: row.prNumber,
    vars: row.vars,
    created_at: new Date(row.createdAt),
    updated_at: new Date(row.updatedAt),
  };
}

function toStepRow(step: Step): typeof steps.$inferInsert {
  return {
    id: step.id,
    taskId: step.task_id,
    stepId: step.step_id,
    parentStepId: step.parent_step_id,
    iteration: step.iteration,
    agentId: step.agent_id,
    status: step.status,
    failureReason: step.failure_reason,
    attempt: step.attempt,
    checkFixAttempt: step.check_fix_attempt,
    checkStatus: step.check_status,
    promptPath: step.prompt_path,
    outputPath: step.output_path,
    diffPath: step.diff_path,
    exitCode: step.exit_code,
    startedAt: step.started_at.toISOString(),
    finishedAt: step.finished_at?.toISOString() ?? null,
  };
}

function fromStepRow(row: StepRow): Step {
  return {
    id: row.id,
    task_id: row.taskId,
    step_id: row.stepId,
    parent_step_id: row.parentStepId,
    iteration: row.iteration,
    agent_id: row.agentId,
    status: row.status,
    failure_reason: row.failureReason,
    attempt: row.attempt,
    check_fix_attempt: row.checkFixAttempt,
    check_status: row.checkStatus,
    prompt_path: row.promptPath,
    output_path: row.outputPath,
    diff_path: row.diffPath,
    exit_code: row.exitCode,
    started_at: new Date(row.startedAt),
    finished_at: row.finishedAt === null ? null : new Date(row.finishedAt),
  };
}

function toStepPatch(patch: Partial<Step>): Partial<typeof steps.$inferInsert> {
  const rowPatch: Partial<typeof steps.$inferInsert> = {};

  if (patch.task_id !== undefined) rowPatch.taskId = patch.task_id;
  if (patch.step_id !== undefined) rowPatch.stepId = patch.step_id;
  if (patch.parent_step_id !== undefined) rowPatch.parentStepId = patch.parent_step_id;
  if (patch.iteration !== undefined) rowPatch.iteration = patch.iteration;
  if (patch.agent_id !== undefined) rowPatch.agentId = patch.agent_id;
  if (patch.status !== undefined) rowPatch.status = patch.status;
  if (patch.failure_reason !== undefined) rowPatch.failureReason = patch.failure_reason;
  if (patch.attempt !== undefined) rowPatch.attempt = patch.attempt;
  if (patch.check_fix_attempt !== undefined) rowPatch.checkFixAttempt = patch.check_fix_attempt;
  if (patch.check_status !== undefined) rowPatch.checkStatus = patch.check_status;
  if (patch.prompt_path !== undefined) rowPatch.promptPath = patch.prompt_path;
  if (patch.output_path !== undefined) rowPatch.outputPath = patch.output_path;
  if (patch.diff_path !== undefined) rowPatch.diffPath = patch.diff_path;
  if (patch.exit_code !== undefined) rowPatch.exitCode = patch.exit_code;
  if (patch.started_at !== undefined) rowPatch.startedAt = patch.started_at.toISOString();
  if (patch.finished_at !== undefined) rowPatch.finishedAt = patch.finished_at?.toISOString() ?? null;

  return rowPatch;
}

function toCheckRow(check: Check): typeof checks.$inferInsert {
  return {
    id: check.id,
    stepRowId: check.step_row_id,
    checkFixAttempt: check.check_fix_attempt,
    commandName: check.command_name,
    command: check.command,
    exitCode: check.exit_code,
    stdoutPath: check.stdout_path,
    stderrPath: check.stderr_path,
    durationMs: check.duration_ms,
    createdAt: check.created_at.toISOString(),
  };
}

function toTaskStoreError(error: unknown): Error {
  if (isActiveTaskConflict(error)) {
    return new Error('active task already exists for project');
  }
  return error instanceof Error ? error : new Error(String(error));
}

function isActiveTaskConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    (/UNIQUE constraint failed: tasks\.project_id/i.test(error.message) ||
      /active task already exists for project/i.test(error.message))
  );
}

function isActiveStatus(status: TaskStatus): boolean {
  return status === 'running' || status === 'paused';
}

function isTerminalStatus(status: TaskStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'canceled';
}
