import type { AgentRunner } from './agent-runner';
import type { CheckRunnerRequest } from './check-runner';
import { WorkflowError } from './errors';
import { PipelineExecutor, type PipelineArtifactStore } from './pipeline-executor';
import { PipelineLifecycle } from './pipeline-lifecycle';
import { pipelineBranchName, pipelineWorktreePath } from './pipeline-paths';
import type { ProjectMeta } from './project-registry';
import type { CreateTaskInput, TaskStore } from './task-store';
import type { CheckRunResult, Task, TaskSource } from './types';
import type { ParsedWorkflow } from './workflow-registry';
import type { WorktreeHandle } from './worktree-manager';

export interface TaskInput {
  title: string;
  description: string;
  source: TaskSource;
  externalRef?: CreateTaskInput['external_ref'];
  issueNumber?: number | null;
}

export interface RunOpts {
  workflowId?: string;
  vars?: Record<string, string>;
}

export interface DefaultPipelineEngineOptions {
  projectRegistry: Pick<ProjectRegistryLike, 'get'>;
  workflowRegistry: Pick<WorkflowRegistryLike, 'get'>;
  taskStore: Pick<
      TaskStore,
    | 'createTask'
    | 'getTask'
    | 'listActiveTasks'
    | 'acquireProjectLock'
    | 'releaseProjectLock'
    | 'createStep'
    | 'updateStep'
    | 'updateTaskStatus'
    | 'updateTaskFinalSlices'
    | 'listSteps'
    | 'cancelTask'
  >;
  worktreeManager: WorktreeManagerLike;
  agentRunner: AgentRunner;
  checkRunner?: CheckRunnerLike;
  artifactStore: PipelineArtifactStore;
  createId?: () => string;
  now?: () => Date;
}

interface ProjectRegistryLike {
  get(projectId: string): ProjectMeta | null;
}

interface WorkflowRegistryLike {
  get(workflowId: string): ParsedWorkflow | null;
}

interface WorktreeManagerLike {
  create(task: Task): Promise<WorktreeHandle>;
}

interface CheckRunnerLike {
  run(request: CheckRunnerRequest): Promise<CheckRunResult>;
}

export class DefaultPipelineEngine {
  private readonly projectRegistry: Pick<ProjectRegistryLike, 'get'>;
  private readonly workflowRegistry: Pick<WorkflowRegistryLike, 'get'>;
  private readonly taskStore: Pick<
    TaskStore,
    | 'createTask'
    | 'getTask'
    | 'listActiveTasks'
    | 'acquireProjectLock'
    | 'releaseProjectLock'
    | 'createStep'
    | 'updateStep'
    | 'updateTaskStatus'
    | 'updateTaskFinalSlices'
    | 'listSteps'
    | 'cancelTask'
  >;
  private readonly worktreeManager: WorktreeManagerLike;
  private readonly agentRunner: AgentRunner;
  private readonly checkRunner: CheckRunnerLike | null;
  private readonly artifactStore: PipelineArtifactStore;
  private readonly lifecycle: PipelineLifecycle;
  private readonly executor: PipelineExecutor;
  private readonly createId: () => string;
  private readonly now: () => Date;

  constructor(options: DefaultPipelineEngineOptions) {
    this.projectRegistry = options.projectRegistry;
    this.workflowRegistry = options.workflowRegistry;
    this.taskStore = options.taskStore;
    this.worktreeManager = options.worktreeManager;
    this.agentRunner = options.agentRunner;
    this.checkRunner = options.checkRunner ?? null;
    this.artifactStore = options.artifactStore;
    this.createId = options.createId ?? cryptoRandomId;
    this.now = options.now ?? (() => new Date());
    this.lifecycle = new PipelineLifecycle({ taskStore: this.taskStore, createId: this.createId });
    this.executor = new PipelineExecutor({
      taskStore: this.taskStore,
      agentRunner: this.agentRunner,
      artifactStore: this.artifactStore,
      createId: this.createId,
      now: this.now,
      ...(this.checkRunner === null ? {} : { checkRunner: this.checkRunner }),
    });
  }

  async runFull(projectId: string, input: TaskInput, opts: RunOpts = {}): Promise<string> {
    const project = this.requireProject(projectId);
    const workflowId = opts.workflowId ?? project.default_workflow;
    const workflow = this.requireWorkflow(workflowId);
    const task = await this.createAndLockTask(project, workflow, input, opts);
    await this.worktreeManager.create(task);

    await this.executor.executeWorkflow(task, workflow, project);
    await this.taskStore.releaseProjectLock(project.id, task.id);

    return task.id;
  }

  async cancel(taskId: string): Promise<void> {
    await this.lifecycle.cancel(taskId);
  }

  async pause(taskId: string): Promise<void> {
    await this.lifecycle.pause(taskId);
  }

  async resume(taskId: string): Promise<void> {
    await this.lifecycle.resume(taskId);
  }

  async recoverPending(): Promise<void> {
    for (const task of await this.taskStore.listActiveTasks()) {
      const workflow = this.requireWorkflow(task.workflow_id);
      const project = this.requireProject(task.project_id);
      await this.worktreeManager.create(task);
      const steps = await this.taskStore.listSteps(task.id);
      if (steps.some((step) => step.status === 'failed')) continue;

      const runningStep = steps.find((step) => step.status === 'running');
      const startStepId = runningStep?.step_id ?? steps.filter((step) => step.status === 'done').at(-1)?.step_id;
      const matchedIndex = startStepId === undefined ? -1 : workflow.steps.findIndex((step) => step.id === startStepId);
      if (matchedIndex === -1) {
        await this.executor.executeWorkflowFrom(task, workflow, project, 0, steps.length + 1);
        continue;
      }

      const startIndex = runningStep === undefined ? matchedIndex + 1 : matchedIndex;
      if (startIndex < workflow.steps.length) {
        await this.executor.executeWorkflowFrom(task, workflow, project, startIndex, steps.length + 1);
      }
    }
  }

  private requireProject(projectId: string): ProjectMeta {
    const project = this.projectRegistry.get(projectId);
    if (project === null) {
      throw new WorkflowError('output_contract_failed', `Unknown project: ${projectId}`);
    }
    return project;
  }

  private requireWorkflow(workflowId: string): ParsedWorkflow {
    const workflow = this.workflowRegistry.get(workflowId);
    if (workflow === null) {
      throw new WorkflowError('output_contract_failed', `Unknown workflow: ${workflowId}`);
    }
    return workflow;
  }

  private async createAndLockTask(
    project: ProjectMeta,
    workflow: ParsedWorkflow,
    input: TaskInput,
    opts: RunOpts,
  ): Promise<Task> {
    const taskId = this.createId();
    const task = await this.taskStore.createTask({
      id: taskId,
      project_id: project.id,
      workflow_id: workflow.id,
      title: input.title,
      description: input.description,
      status: 'queued',
      source: input.source,
      external_ref: input.externalRef ?? null,
      issue_number: input.issueNumber ?? null,
      branch_name: pipelineBranchName(taskId, input.title),
      worktree_path: pipelineWorktreePath(taskId),
      pr_number: null,
      final_slices: [],
      vars: opts.vars ?? {},
    });

    const locked = await this.taskStore.acquireProjectLock(project.id, task.id);
    if (!locked) {
      throw new WorkflowError('output_contract_failed', `Project is already locked: ${project.id}`);
    }

    return task;
  }

}

function cryptoRandomId(): string {
  return crypto.randomUUID();
}
