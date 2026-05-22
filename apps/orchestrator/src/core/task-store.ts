import type { Check, ExternalRef, Step, Task, TaskStatus } from './types';

export type CreateTaskInput = Omit<Task, 'created_at' | 'updated_at' | 'failure_reason'> & {
  failure_reason?: string | null;
  external_ref: ExternalRef | null;
};

export type CreateStepInput = Step;

export type CreateCheckInput = Omit<Check, 'created_at'> & {
  created_at?: Date;
};

export interface TaskStore {
  createTask(input: CreateTaskInput): Promise<Task>;
  updateTaskStatus(id: string, status: TaskStatus): Promise<void>;
  getTask(id: string): Promise<Task | null>;
  listActiveTasks(projectId?: string): Promise<Task[]>;
  acquireProjectLock(projectId: string, taskId: string): Promise<boolean>;
  releaseProjectLock(projectId: string, taskId: string): Promise<void>;
  createStep(input: CreateStepInput): Promise<Step>;
  updateStep(id: string, patch: Partial<Step>): Promise<void>;
  listSteps(taskId: string): Promise<Step[]>;
  recordCheck(input: CreateCheckInput): Promise<Check>;
}
