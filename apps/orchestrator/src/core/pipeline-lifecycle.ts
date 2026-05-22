import { WorkflowError } from './errors';
import type { TaskStore } from './task-store';

export interface PipelineLifecycleOptions {
  taskStore: Pick<TaskStore, 'getTask' | 'updateTaskStatus' | 'acquireProjectLock' | 'releaseProjectLock' | 'cancelTask'>;
  createId: () => string;
}

export class PipelineLifecycle {
  private readonly taskStore: PipelineLifecycleOptions['taskStore'];
  private readonly createId: () => string;

  constructor(options: PipelineLifecycleOptions) {
    this.taskStore = options.taskStore;
    this.createId = options.createId;
  }

  async cancel(taskId: string): Promise<void> {
    const task = await this.taskStore.getTask(taskId);
    if (task === null) return;

    await this.taskStore.cancelTask(task.id, this.createId(), { reason: 'user_requested' });
    await this.taskStore.releaseProjectLock(task.project_id, task.id);
  }

  async pause(taskId: string): Promise<void> {
    const task = await this.taskStore.getTask(taskId);
    if (task === null || task.status === 'canceled') return;

    await this.taskStore.updateTaskStatus(task.id, 'paused');
  }

  async resume(taskId: string): Promise<void> {
    const task = await this.taskStore.getTask(taskId);
    if (task === null) return;
    if (task.status === 'canceled') {
      throw new WorkflowError('output_contract_failed', `Canceled task cannot resume: ${task.id}`);
    }

    await this.taskStore.updateTaskStatus(task.id, 'running');
    await this.taskStore.acquireProjectLock(task.project_id, task.id);
  }
}
