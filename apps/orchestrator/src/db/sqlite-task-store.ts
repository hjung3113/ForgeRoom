import { and, asc, eq, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { CreateTaskInput, TaskStore } from '../core/task-store';
import type { Task, TaskStatus } from '../core/types';
import type { TaskStoreDatabase } from './client';
import * as schema from './schema';
import { tasks } from './schema';

type Database = BetterSQLite3Database<typeof schema>;
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
