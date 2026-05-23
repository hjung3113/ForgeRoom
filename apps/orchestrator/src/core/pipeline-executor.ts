import type { AgentRunner } from './agent-runner';
import type { CheckRunnerRequest } from './check-runner';
import { WorkflowError } from './errors';
import { parseReviewPassedOutput, parseSlicesOutput } from './output-selectors';
import { pipelineStepArtifactPaths } from './pipeline-paths';
import type { ProjectMeta } from './project-registry';
import type { TaskStore } from './task-store';
import type { CheckRunResult, Step, Task } from './types';
import type { ParsedWorkflow, ResolvedExecutableStep, ResolvedStep } from './workflow-registry';

export interface PipelineExecutorOptions {
  taskStore: Pick<
    TaskStore,
    'createStep' | 'updateStep' | 'updateTaskStatus' | 'updateTaskFinalSlices'
  >;
  agentRunner: AgentRunner;
  checkRunner?: CheckRunnerLike;
  artifactStore: PipelineArtifactStore;
  createId: () => string;
  now: () => Date;
}

export interface PipelineArtifactStore {
  readPromptTemplate(relativePath: string): Promise<string>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

interface CheckRunnerLike {
  run(request: CheckRunnerRequest): Promise<CheckRunResult>;
}

export class PipelineExecutor {
  private readonly taskStore: PipelineExecutorOptions['taskStore'];
  private readonly agentRunner: AgentRunner;
  private readonly checkRunner: CheckRunnerLike | null;
  private readonly artifactStore: PipelineArtifactStore;
  private readonly createId: () => string;
  private readonly now: () => Date;

  constructor(options: PipelineExecutorOptions) {
    this.taskStore = options.taskStore;
    this.agentRunner = options.agentRunner;
    this.checkRunner = options.checkRunner ?? null;
    this.artifactStore = options.artifactStore;
    this.createId = options.createId;
    this.now = options.now;
  }

  async executeWorkflow(task: Task, workflow: ParsedWorkflow, project: ProjectMeta): Promise<void> {
    await this.executeSteps(task, workflow.steps, project, { value: 1 });
  }

  async executeWorkflowFrom(
    task: Task,
    workflow: ParsedWorkflow,
    project: ProjectMeta,
    startStepIndex: number,
    artifactIndex: number,
  ): Promise<void> {
    await this.executeSteps(task, workflow.steps.slice(startStepIndex), project, { value: artifactIndex });
  }

  private async executeSteps(
    task: Task,
    steps: ResolvedStep[],
    project: ProjectMeta,
    nextStepIndex: { value: number },
    localVars: Record<string, string> = {},
  ): Promise<void> {
    for (const step of steps) {
      if (step.type === 'run') {
        await this.executeStep(task, step as ResolvedExecutableStep, project, nextStepIndex.value, localVars);
        nextStepIndex.value += 1;
        continue;
      }

      if (step.type === 'group' && step.foreach === '${task.final_slices}') {
        for (const slice of task.final_slices) {
          await this.executeSteps(task, step.steps, project, nextStepIndex, { ...localVars, [step.as ?? 'slice']: slice });
        }
        continue;
      }

      if (step.type === 'review_loop') {
        await this.executeReviewLoop(task, step, project, nextStepIndex, localVars);
      }
    }
  }

  private async executeReviewLoop(
    task: Task,
    loop: ResolvedStep,
    project: ProjectMeta,
    nextStepIndex: { value: number },
    localVars: Record<string, string>,
  ): Promise<void> {
    const controlStep = await this.createControlStep(task, loop.id, nextStepIndex.value);
    const review = loop.review;
    const refine = loop.refine;
    if (review === null || refine === null) {
      throw new WorkflowError('output_contract_failed', `review_loop ${loop.id} is missing review or refine step`);
    }
    nextStepIndex.value += 1;
    let iteration = 0;
    let passed = false;

    while (iteration <= (loop.max_iterations ?? 1)) {
      const reviewStep = await this.executeStep(task, review, project, nextStepIndex.value, localVars, {
        parentStepId: controlStep.id,
        iteration,
      });
      nextStepIndex.value += 1;
      passed = parseReviewPassedOutput(await this.artifactStore.readFile(reviewStep.output_path));
      if (passed) break;
      if (iteration >= (loop.max_iterations ?? 1)) break;

      await this.executeStep(task, refine, project, nextStepIndex.value, localVars, {
        parentStepId: controlStep.id,
        iteration,
      });
      nextStepIndex.value += 1;
      iteration += 1;
    }

    if (!passed) {
      await this.taskStore.updateStep(controlStep.id, {
        status: 'failed',
        failure_reason: 'review_loop_max_iterations',
        finished_at: this.now(),
      });
      await this.taskStore.updateTaskStatus(task.id, 'failed', 'review_loop_max_iterations');
      return;
    }

    await this.taskStore.updateStep(controlStep.id, { status: 'done', finished_at: this.now() });
  }

  private async createControlStep(task: Task, stepId: string, stepIndex: number): Promise<Step> {
    const paths = pipelineStepArtifactPaths(task.worktree_path, stepIndex, stepId);
    const step: Step = {
      id: this.createId(),
      task_id: task.id,
      step_id: stepId,
      parent_step_id: null,
      iteration: 0,
      agent_id: 'pipeline',
      status: 'running',
      failure_reason: null,
      attempt: 0,
      check_fix_attempt: 0,
      check_status: 'not_run',
      prompt_path: paths.promptPath,
      output_path: paths.outputPath,
      diff_path: null,
      exit_code: null,
      started_at: this.now(),
      finished_at: null,
    };
    return this.taskStore.createStep(step);
  }

  private async executeStep(
    task: Task,
    step: ResolvedExecutableStep,
    project: ProjectMeta,
    stepIndex: number,
    localVars: Record<string, string>,
    options: { parentStepId?: string; iteration?: number } = {},
  ): Promise<Step> {
    const startedAt = this.now();
    const paths = pipelineStepArtifactPaths(task.worktree_path, stepIndex, step.id);
    await this.artifactStore.writeFile(paths.promptPath, await this.renderPrompt(task, step, localVars));

    const stepRow: Step = {
      id: this.createId(),
      task_id: task.id,
      step_id: step.id,
      parent_step_id: options.parentStepId ?? null,
      iteration: options.iteration ?? 0,
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
      if (!checkResult.allPassed) return stepRow;
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
    if (agentSucceeded && isSliceProducingStep(step)) {
      const slices = parseSlicesOutput(await this.artifactStore.readFile(paths.outputPath));
      await this.taskStore.updateTaskFinalSlices(task.id, slices);
      task.final_slices = slices;
    }
    return stepRow;
  }

  private requireCheckRunner(): CheckRunnerLike {
    if (this.checkRunner === null) {
      throw new WorkflowError('output_contract_failed', 'CheckRunner is required for execute steps');
    }
    return this.checkRunner;
  }

  private async renderPrompt(task: Task, step: ResolvedExecutableStep, localVars: Record<string, string>): Promise<string> {
    const template = await this.artifactStore.readPromptTemplate(step.prompt_template);
    let prompt = template
      .replaceAll('${task.title}', task.title)
      .replaceAll('${task.description}', task.description)
      .replaceAll('${task.project}', task.project_id)
      .replaceAll('${task.worktree_path}', task.worktree_path);
    for (const [key, value] of Object.entries(localVars)) {
      prompt = prompt.replaceAll(`\${${key}}`, value);
    }
    return prompt;
  }
}

function isSliceProducingStep(step: ResolvedExecutableStep): boolean {
  return step.prompt_template === 'implementation_plan.md' || step.prompt_template === 'refine_plan.md';
}
