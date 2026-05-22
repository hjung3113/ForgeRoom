import type { ExternalRef, Task, TaskStatus } from './types';

export type CreateTaskInput = Omit<Task, 'created_at' | 'updated_at' | 'failure_reason'> & {
  failure_reason?: string | null;
  external_ref: ExternalRef | null;
};

export interface TaskStore {
  createTask(input: CreateTaskInput): Promise<Task>;
  updateTaskStatus(id: string, status: TaskStatus): Promise<void>;
  getTask(id: string): Promise<Task | null>;
  listActiveTasks(projectId?: string): Promise<Task[]>;
  acquireProjectLock(projectId: string, taskId: string): Promise<boolean>;
  releaseProjectLock(projectId: string, taskId: string): Promise<void>;
}
