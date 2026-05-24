import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { AgentRunner } from '../agent-runner.js';
import type { ApprovalGate } from '../approval-gate.js';
import type { CheckRunnerRequest } from '../check-runner.js';
import { OrchestratorError } from '../errors.js';
import { parseReviewPassedOutput, parseSlicesOutput } from '../output-selectors.js';
import type { ProjectMeta } from '../project-registry.js';
import type { TaskStore } from '../task-store.js';
import type { Conductor, ReporterEvent, Step, StepResult, Task } from '../types.js';
import type { CheckRunResult } from '../types.js';
import type {
  AdapterCollaborators,
  AgentRunResult as AdapterAgentRunResult,
  InterpolatedInputs,
  InterpolationSource,
  ResolvedStep as AdapterResolvedStep,
  StepOutputView,
} from '../../dsl/to-mastra.js';

interface StepCollaboratorDeps {
  conductor: Conductor;
  approvalGate: Pick<ApprovalGate, 'checkCommand'>;
  agentRunner: AgentRunner;
  checkRunner: { run(request: CheckRunnerRequest): Promise<CheckRunResult> };
  taskStore: Pick<TaskStore, 'updateTaskFinalSlices'>;
}

interface StepCollaboratorCallbacks {
  recordStepRow(input: {
    task: Task;
    resolved: AdapterResolvedStep;
    run: AdapterAgentRunResult;
  }): Promise<Step>;
  createStepRowId(): string;
  now(): Date;
  notifyStepDone(event: Extract<ReporterEvent, { type: 'step_done' }>): Promise<void>;
  log?: (line: string) => void;
}

export interface StepCollaboratorsOptions {
  task: Task;
  project: ProjectMeta;
  interpolation: InterpolationSource;
  stepOutputs: Record<string, StepOutputView>;
  stepCounter: { value: number };
  promptIndex: Map<string, { index: number; fileBase: string }>;
  agentOverrides: Record<string, string>;
  deps: StepCollaboratorDeps;
  callbacks: StepCollaboratorCallbacks;
}

export class StepCollaborators {
  private readonly task: Task;
  private readonly project: ProjectMeta;
  private readonly interpolation: InterpolationSource;
  private readonly stepOutputs: Record<string, StepOutputView>;
  private readonly stepCounter: { value: number };
  private readonly promptIndex: Map<string, { index: number; fileBase: string }>;
  private readonly agentOverrides: Record<string, string>;
  private readonly deps: StepCollaboratorDeps;
  private readonly callbacks: StepCollaboratorCallbacks;

  constructor(options: StepCollaboratorsOptions) {
    this.task = options.task;
    this.project = options.project;
    this.interpolation = options.interpolation;
    this.stepOutputs = options.stepOutputs;
    this.stepCounter = options.stepCounter;
    this.promptIndex = options.promptIndex;
    this.agentOverrides = options.agentOverrides;
    this.deps = options.deps;
    this.callbacks = options.callbacks;
  }

  asAdapterCollaborators(): AdapterCollaborators {
    return {
      renderPrompt: (resolved, inputs) => this.renderPrompt(resolved, inputs),
      runAgent: (resolved, promptPath, inputs) => this.runAgent(resolved, promptPath, inputs),
      runChecks: (resolved, run) => this.runChecks(resolved, run),
      saveDiff: (resolved, run) => this.saveDiff(resolved, run),
      conductorUpdate: (resolved, run) => this.conductorUpdate(resolved, run),
      suspend: (resolved) => this.suspend(resolved),
    };
  }

  async renderPrompt(resolved: AdapterResolvedStep, inputs: InterpolatedInputs): Promise<string> {
    const index = (this.stepCounter.value += 1);
    const fileBase = `${pad2(index)}_${resolved.stepId}`;
    const promptPath = path.join(this.task.worktree_path, '.forgeroom', 'prompts', `${fileBase}.md`);
    const base = renderBasePrompt(resolved, inputs);
    const refined = await this.deps.conductor.refine(this.task.id, resolved.stepId, base);
    await mkdir(path.dirname(promptPath), { recursive: true });
    await writeFile(promptPath, refined);
    this.promptIndex.set(resolved.mastraStepId, { index, fileBase });
    return promptPath;
  }

  async runAgent(
    resolved: AdapterResolvedStep,
    promptPath: string,
    _inputs: InterpolatedInputs,
  ): Promise<AdapterAgentRunResult> {
    const meta = this.promptIndex.get(resolved.mastraStepId);
    const fileBase = meta?.fileBase ?? `${pad2(this.stepCounter.value)}_${resolved.stepId}`;
    const outputPath = path.join(this.task.worktree_path, '.forgeroom', 'outputs', `${fileBase}.md`);
    const stdoutPath = path.join(this.task.worktree_path, '.forgeroom', 'logs', `${fileBase}.stdout`);
    const stderrPath = path.join(this.task.worktree_path, '.forgeroom', 'logs', `${fileBase}.stderr`);
    const agentId = this.agentOverrides[resolved.agent] ?? resolved.agent;

    const agentCommand = `read ${promptPath} && write ${outputPath}`;
    const decision = this.deps.approvalGate.checkCommand(agentCommand, this.task.worktree_path);
    if (!decision.allowed) {
      throw new OrchestratorError(
        'agent_error',
        `in-step gate denied agent command for ${resolved.stepId}: ${decision.reason ?? 'denied'}`,
      );
    }

    await mkdir(path.dirname(outputPath), { recursive: true });
    const result = await this.deps.agentRunner.run({
      agentId,
      promptPath,
      outputPath,
      stdoutPath,
      stderrPath,
      cwd: this.task.worktree_path,
      mode: 'headless',
    });

    if (result.failureKind !== undefined || !result.outputExists) {
      throw new OrchestratorError(
        result.failureKind ?? 'output_contract_failed',
        `agent run failed for step ${resolved.stepId}`,
      );
    }

    const output = await readFile(outputPath, 'utf8');
    return { outputPath, output, diffPath: null };
  }

  async runChecks(
    resolved: AdapterResolvedStep,
    run: AdapterAgentRunResult,
  ): Promise<{ allPassed: boolean }> {
    const step = await this.callbacks.recordStepRow({ task: this.task, resolved, run });
    const result = await this.deps.checkRunner.run({ task: this.task, step, project: this.project });
    return { allPassed: result.allPassed };
  }

  saveDiff(_resolved: AdapterResolvedStep, run: AdapterAgentRunResult): Promise<string | null> {
    return Promise.resolve(run.diffPath);
  }

  async conductorUpdate(resolved: AdapterResolvedStep, run: AdapterAgentRunResult): Promise<void> {
    const stepResult: StepResult = {
      stepId: resolved.stepId,
      promptPath: this.promptIndex.get(resolved.mastraStepId)?.fileBase ?? resolved.stepId,
      outputPath: run.outputPath,
      diffPath: run.diffPath,
      status: 'done',
    };
    await this.deps.conductor.update(this.task.id, stepResult);

    let slices: string[] | null;
    try {
      slices = parseSlicesOutput(run.output);
    } catch {
      slices = null;
    }
    let passed: boolean | undefined;
    if (resolved.kind === 'review') {
      try {
        passed = parseReviewPassedOutput(run.output);
      } catch {
        passed = undefined;
      }
    }
    this.stepOutputs[resolved.stepId] = {
      output: run.output,
      output_path: run.outputPath,
      diff_path: run.diffPath,
      ...(passed === undefined ? {} : { passed }),
      ...(slices === null ? {} : { slices }),
    };
    if (slices !== null) {
      await this.deps.taskStore.updateTaskFinalSlices(this.task.id, slices);
      this.interpolation.task.final_slices = slices;
    }

    await this.callbacks.notifyStepDone({
      type: 'step_done',
      task: this.task,
      step: makeReporterStep(this.task, resolved, run, this.callbacks.createStepRowId, this.callbacks.now),
    });
  }

  suspend(_resolved: AdapterResolvedStep): Promise<void> {
    return Promise.resolve();
  }
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function renderBasePrompt(resolved: AdapterResolvedStep, inputs: InterpolatedInputs): string {
  const lines = [`# Step: ${resolved.stepId}`, `Template: ${resolved.promptTemplate}`, ''];
  const refs = Object.entries(inputs.input_refs);
  if (refs.length > 0) {
    lines.push('## Inputs');
    for (const [k, v] of refs) {
      lines.push(`- ${k}: ${String(v)}`);
    }
  }
  return lines.join('\n');
}

function makeReporterStep(
  task: Task,
  resolved: AdapterResolvedStep,
  run: AdapterAgentRunResult,
  createId: () => string,
  now: () => Date,
): Step {
  return {
    id: createId(),
    task_id: task.id,
    step_id: resolved.stepId,
    parent_step_id: null,
    iteration: 0,
    agent_id: resolved.agent,
    status: 'done',
    failure_reason: null,
    attempt: 1,
    check_fix_attempt: 0,
    check_status: 'not_run',
    prompt_path: '',
    output_path: run.outputPath,
    diff_path: run.diffPath,
    exit_code: 0,
    started_at: now(),
    finished_at: now(),
  };
}
