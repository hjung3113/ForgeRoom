import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { AgentRunner, ResolvedRuntimeTarget } from '../agent-runtime/agent-runner.js';
import type { AgentRegistry } from '../agent-runtime/agent-registry.js';
import type { HarnessRegistry } from '../agent-runtime/harness-registry.js';
import type { HarnessManifest } from '../agent-runtime/harness-manifest.js';
import type { ApprovalGate } from '../checks/approval-gate.js';
import type { CheckRunnerRequest } from '../checks/check-runner.js';
import { OrchestratorError } from '../errors.js';
import { parseReviewPassedOutput, parseSlicesOutput } from './output-selectors.js';
import type { IntentRegistry } from '../registries/intent-registry.js';
import type { ModelPolicyRegistry } from '../registries/model-policy-registry.js';
import type { ProjectMeta, ProjectRoom } from '../registries/project-registry.js';
import { resolveRuntimeSession } from './runtime-session.js';
import { compileRuntimeProfile } from './runtime-profile-compiler.js';
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
} from '../../workflow/types.js';

interface StepCollaboratorDeps {
  conductor: Conductor;
  approvalGate: Pick<ApprovalGate, 'checkCommand'>;
  agentRunner: AgentRunner;
  checkRunner: { run(request: CheckRunnerRequest): Promise<CheckRunResult> };
  taskStore: Pick<TaskStore, 'updateTaskFinalSlices'>;
  /** Resolves a step's intent to read its optional `model_policy` (ADR-024). */
  intentRegistry: Pick<IntentRegistry, 'resolve'>;
  /** Resolves a model policy to its primary runtime target (ADR-024). */
  modelPolicies: Pick<ModelPolicyRegistry, 'resolveTarget'>;
  /** Resolves the agent for the agent-derived runtime target fallback. */
  agentRegistry: Pick<AgentRegistry, 'resolve'>;
  /** Resolves a Step Harness id to its worktree-relative contract source (prompt-file-protocol step 8). */
  harnessRegistry: Pick<HarnessRegistry, 'resolve'>;
  /** Bundled harness manifests (id → parsed `harness.yaml`, ADR-029 E2). Optional — absent → no output-contract validation. */
  harnessManifests?: ReadonlyMap<string, HarnessManifest>;
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
  /** Project Room view (ADR-028); drives per-run OpenClaw session/agent override. */
  projectRoom?: ProjectRoom | null;
  interpolation: InterpolationSource;
  stepOutputs: Record<string, StepOutputView>;
  stepCounter: { value: number };
  promptIndex: Map<string, { index: number; fileBase: string }>;
  agentOverrides: Record<string, string>;
  /** Bundled template root; `promptTemplate` is resolved relative to it (prompt-file-protocol). */
  templateRoot: string;
  deps: StepCollaboratorDeps;
  callbacks: StepCollaboratorCallbacks;
}

export class StepCollaborators {
  private readonly task: Task;
  private readonly project: ProjectMeta;
  private readonly projectRoom: ProjectRoom | null;
  private readonly interpolation: InterpolationSource;
  private readonly stepOutputs: Record<string, StepOutputView>;
  private readonly stepCounter: { value: number };
  private readonly promptIndex: Map<string, { index: number; fileBase: string }>;
  private readonly agentOverrides: Record<string, string>;
  private readonly templateRoot: string;
  private readonly deps: StepCollaboratorDeps;
  private readonly callbacks: StepCollaboratorCallbacks;

  constructor(options: StepCollaboratorsOptions) {
    this.task = options.task;
    this.project = options.project;
    this.projectRoom = options.projectRoom ?? null;
    this.interpolation = options.interpolation;
    this.stepOutputs = options.stepOutputs;
    this.stepCounter = options.stepCounter;
    this.promptIndex = options.promptIndex;
    this.agentOverrides = options.agentOverrides;
    this.templateRoot = options.templateRoot;
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
    const template = await this.loadTemplate(resolved.promptTemplate);
    const renderedTemplate = renderTemplate(
      template,
      resolved,
      inputs,
      pad2(index),
      resolved.promptTemplate,
    );
    const base = await this.composeWithHarness(resolved, inputs, pad2(index), renderedTemplate);
    const refined = await this.deps.conductor.refine(this.task.id, resolved.stepId, base);
    await mkdir(path.dirname(promptPath), { recursive: true });
    await writeFile(promptPath, refined);
    this.promptIndex.set(resolved.mastraStepId, { index, fileBase });
    return promptPath;
  }

  /** Read a bundled prompt template (resolved relative to the template root). */
  private async loadTemplate(relativePath: string): Promise<string> {
    const templatePath = path.join(this.templateRoot, relativePath);
    try {
      return await readFile(templatePath, 'utf8');
    } catch {
      throw new OrchestratorError(
        'agent_error',
        `prompt template not found: ${relativePath} (template root: ${this.templateRoot})`,
      );
    }
  }

  /**
   * Compose the harness prompt/output contract BEFORE the step prompt template
   * (prompt-file-protocol step 8). Both halves use the same `{{}}` interpolation
   * and fail fast on an unknown placeholder. When the step has no harness
   * (`resolved.harness` null/absent — e.g. non-run steps) the rendered template
   * is returned unchanged (template-only, the pre-#69 behavior).
   */
  private async composeWithHarness(
    resolved: AdapterResolvedStep,
    inputs: InterpolatedInputs,
    stepIndex: string,
    renderedTemplate: string,
  ): Promise<string> {
    if (resolved.harness === null) {
      return renderedTemplate;
    }
    const source = this.deps.harnessRegistry.resolve(resolved.harness).source;
    const harnessTemplate = await this.loadHarness(resolved.harness, source);
    const renderedHarness = renderTemplate(harnessTemplate, resolved, inputs, stepIndex, source);

    // Advisory block from the compiled runtime profile (ADR-029 E4). Soft text
    // only — the model is asked to honor permissions/tools; hard enforcement is
    // ForgeRoom-owned (ApprovalGate + diff checks). Skipped when no manifest is
    // wired or the manifest declares no permissions/tools.
    const manifest = this.deps.harnessManifests?.get(resolved.harness);
    const advisory = manifest === undefined ? null : compileRuntimeProfile(manifest).advisory;

    const parts = ['# Harness Contract', '', renderedHarness];
    if (advisory !== null) {
      parts.push('', '---', '', advisory);
    }
    parts.push('', '---', '', '# Step Prompt', '', renderedTemplate);
    return parts.join('\n');
  }

  /**
   * Read a staged Step Harness prompt contract from the worktree
   * (`<worktree>/<source>/prompt-contract.md`), where `source` is the
   * worktree-relative harness DIR WorktreeManager bootstrapped (ADR-029). The
   * prompt contract is staged under the canonical `prompt-contract.md` name.
   * Fails fast when the contract is missing.
   */
  private async loadHarness(harnessId: string, source: string): Promise<string> {
    const harnessPath = path.join(this.task.worktree_path, source, 'prompt-contract.md');
    try {
      return await readFile(harnessPath, 'utf8');
    } catch {
      throw new OrchestratorError(
        'agent_error',
        `harness contract not found: ${harnessId} (expected staged at ${source}/prompt-contract.md in worktree)`,
      );
    }
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

    const { runtimeTarget, policyId } = this.resolveRuntimeTarget(resolved, agentId);
    await this.recordRoutingDecision(resolved, fileBase, policyId, runtimeTarget);

    const intentKind = this.deps.intentRegistry.resolve(resolved.intentId).kind;
    const runtimeSession = resolveRuntimeSession(this.projectRoom, intentKind, this.task.id);
    const outputContract =
      resolved.harness === null
        ? undefined
        : this.deps.harnessManifests?.get(resolved.harness)?.output;

    await mkdir(path.dirname(outputPath), { recursive: true });
    const result = await this.deps.agentRunner.run({
      agentId,
      promptPath,
      outputPath,
      stdoutPath,
      stderrPath,
      cwd: this.task.worktree_path,
      mode: 'headless',
      runtimeTarget,
      ...(runtimeSession === undefined ? {} : { runtimeSession }),
      ...(outputContract === undefined ? {} : { outputContract }),
    });

    if (result.failureKind !== undefined || !result.outputExists) {
      throw new OrchestratorError(
        result.failureKind ?? 'output_contract_failed',
        `agent run failed for step ${resolved.stepId}`,
      );
    }

    const output = await readFile(outputPath, 'utf8');
    return {
      outputPath,
      output,
      diffPath: null,
      session: {
        openclawSessionId: result.sessionId,
        openclawAgentKey: runtimeSession?.providerAgentId ?? null,
        openclawRole: runtimeSession?.role ?? null,
      },
    };
  }

  /**
   * Resolve the step's runtime target (ADR-024): the intent's model policy if
   * set, otherwise derive from the resolved agent. Always returns a concrete
   * target so the routing decision and the AgentRunRequest agree.
   */
  private resolveRuntimeTarget(
    resolved: AdapterResolvedStep,
    agentId: string,
  ): { runtimeTarget: ResolvedRuntimeTarget; policyId: string | null } {
    const intent = this.deps.intentRegistry.resolve(resolved.intentId);
    if (intent.model_policy !== undefined) {
      return { runtimeTarget: this.deps.modelPolicies.resolveTarget(intent.model_policy), policyId: intent.model_policy };
    }
    const agent = this.deps.agentRegistry.resolve(agentId);
    return {
      runtimeTarget: { providerId: agent.provider, runtime: agent.runtime, model: agent.model },
      policyId: null,
    };
  }

  /** Write the per-step routing-decision artifact (ADR-024), always. */
  private async recordRoutingDecision(
    resolved: AdapterResolvedStep,
    fileBase: string,
    policyId: string | null,
    target: ResolvedRuntimeTarget,
  ): Promise<void> {
    const routingPath = path.join(this.task.worktree_path, '.forgeroom', 'routing', `${fileBase}.json`);
    const reason =
      policyId === null ? ['policy=none', 'source=agent'] : [`kind=${resolved.kind}`, `policy=${policyId}`, 'static=true'];
    const decision = {
      stepId: resolved.stepId,
      intentId: resolved.intentId,
      policyId,
      selected: { providerId: target.providerId, runtime: target.runtime, model: target.model },
      fallbackChain: [] as string[],
      reason,
    };
    await mkdir(path.dirname(routingPath), { recursive: true });
    await writeFile(routingPath, `${JSON.stringify(decision, null, 2)}\n`);
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

const PLACEHOLDER_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

/**
 * Substitute `{{key}}` placeholders in a bundled template (prompt-file-protocol).
 * Sources: the step's interpolated `vars` and `input_refs` (the DSL `${...}`
 * layer is already evaluated into these), plus `{{step_id}}` / `{{step_index}}`.
 * An unknown placeholder fails fast — silently shipping a broken prompt is worse.
 */
function renderTemplate(
  template: string,
  resolved: AdapterResolvedStep,
  inputs: InterpolatedInputs,
  stepIndex: string,
  sourceLabel: string,
): string {
  const values: Record<string, string> = { step_id: resolved.stepId, step_index: stepIndex };
  for (const [k, v] of Object.entries(inputs.vars)) {
    values[k] = stringifyValue(v);
  }
  for (const [k, v] of Object.entries(inputs.input_refs)) {
    values[k] = stringifyValue(v);
  }
  return template.replace(PLACEHOLDER_RE, (_match, key: string): string => {
    if (!(key in values)) {
      throw new OrchestratorError(
        'agent_error',
        `unresolved template placeholder {{${key}}} in ${sourceLabel}`,
      );
    }
    return values[key] as string;
  });
}

function stringifyValue(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
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
    openclaw_session_id: run.session?.openclawSessionId ?? null,
    openclaw_agent_key: run.session?.openclawAgentKey ?? null,
    openclaw_role: run.session?.openclawRole ?? null,
  };
}
