import type { AgentRunner } from './agent-runner';
import type { CheckRunnerRequest } from './check-runner';
import { WorkflowError } from './errors';
import { pipelineBranchName, pipelineStepArtifactPaths, pipelineWorktreePath } from './pipeline-paths';
import type { ProjectMeta } from './project-registry';
import type { CreateTaskInput, TaskStore } from './task-store';
import type { CheckRunResult, Step, Task, TaskSource } from './types';
import type { ParsedWorkflow, ResolvedExecutableStep } from './workflow-registry';
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

export interface PipelineArtifactStore {
  readPromptTemplate(relativePath: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

export interface DefaultPipelineEngineOptions {
  projectRegistry: Pick<ProjectRegistryLike, 'get'>;
  workflowRegistry: Pick<WorkflowRegistryLike, 'get'>;
  taskStore: Pick<
      TaskStore,
    | 'createTask'
    | 'getTask'
    | 'acquireProjectLock'
    | 'releaseProjectLock'
    | 'createStep'
    | 'updateStep'
    | 'updateTaskStatus'
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
    | 'acquireProjectLock'
    | 'releaseProjectLock'
    | 'createStep'
    | 'updateStep'
    | 'updateTaskStatus'
    | 'cancelTask'
  >;
  private readonly worktreeManager: WorktreeManagerLike;
  private readonly agentRunner: AgentRunner;
  private readonly checkRunner: CheckRunnerLike | null;
  private readonly artifactStore: PipelineArtifactStore;
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
  }

  async runFull(projectId: string, input: TaskInput, opts: RunOpts = {}): Promise<string> {
    const project = this.requireProject(projectId);
    const workflowId = opts.workflowId ?? project.default_workflow;
    const workflow = this.requireWorkflow(workflowId);
    const task = await this.createAndLockTask(project, workflow, input, opts);
    await this.worktreeManager.create(task);

    const firstStep = firstExecutableStep(workflow);
    await this.executeFirstStep(task, firstStep, project);
    await this.taskStore.releaseProjectLock(project.id, task.id);

    return task.id;
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
      vars: opts.vars ?? {},
    });

    const locked = await this.taskStore.acquireProjectLock(project.id, task.id);
    if (!locked) {
      throw new WorkflowError('output_contract_failed', `Project is already locked: ${project.id}`);
    }

    return task;
  }

  private async executeFirstStep(task: Task, step: ResolvedExecutableStep, project: ProjectMeta): Promise<void> {
    const startedAt = this.now();
    const stepIndex = 1;
    const paths = pipelineStepArtifactPaths(task.worktree_path, stepIndex, step.id);
    const prompt = await this.renderPrompt(task, step);
    await this.artifactStore.writeFile(paths.promptPath, prompt);

    const stepRow: Step = {
      id: this.createId(),
      task_id: task.id,
      step_id: step.id,
      parent_step_id: null,
      iteration: 0,
      agent_id: step.agent,
      status: 'running',
      failure_reason: null,
      attempt: 1,
      check_fix_attempt: 0,
      check_status: 'not_run',
      prompt_path: paths.promptPath,
      output_path: paths.outputPath,
      diff_path: null,
      exit_code: null,
      started_at: startedAt,
      finished_at: null,
    };
    await this.taskStore.createStep(stepRow);

    const result = await this.agentRunner.run({
      agentId: step.agent,
      promptPath: paths.promptPath,
      outputPath: paths.outputPath,
      stdoutPath: paths.stdoutPath,
      stderrPath: paths.stderrPath,
      cwd: task.worktree_path,
      mode: 'headless',
    });
    const agentSucceeded = result.failureKind === undefined && result.exitCode === 0;

    if (agentSucceeded && step.kind === 'execute') {
      const checkResult = await this.requireCheckRunner().run({ task, step: stepRow, project });
      if (!checkResult.allPassed) return;
    }

    const failureReason = result.failureKind;
    await this.taskStore.updateStep(stepRow.id, {
      status: agentSucceeded ? 'done' : 'failed',
      exit_code: result.exitCode,
      ...(failureReason === undefined ? {} : { failure_reason: failureReason }),
      finished_at: this.now(),
    });
    if (!agentSucceeded && failureReason !== undefined) {
      await this.taskStore.updateTaskStatus(task.id, 'failed', failureReason);
    }
  }

  private requireCheckRunner(): CheckRunnerLike {
    if (this.checkRunner === null) {
      throw new WorkflowError('output_contract_failed', 'CheckRunner is required for execute steps');
    }
    return this.checkRunner;
  }

  private async renderPrompt(task: Task, step: ResolvedExecutableStep): Promise<string> {
    const template = await this.artifactStore.readPromptTemplate(step.prompt_template);
    return template
      .replaceAll('${task.title}', task.title)
      .replaceAll('${task.description}', task.description)
      .replaceAll('${task.project}', task.project_id)
      .replaceAll('${task.worktree_path}', task.worktree_path);
  }
}

function firstExecutableStep(workflow: ParsedWorkflow): ResolvedExecutableStep {
  const step = workflow.steps[0];
  if (step?.type !== 'run') {
    throw new WorkflowError('output_contract_failed', 'Workflow must start with an executable run step');
  }
  return step as ResolvedExecutableStep;
}

function cryptoRandomId(): string {
  return crypto.randomUUID();
}
