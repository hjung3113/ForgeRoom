/**
 * yaml DSL -> Mastra workflow adapter (ADR-016).
 *
 * Single responsibility: translate a parsed ForgeRoom workflow + Intent Catalog
 * into a committed Mastra `createWorkflow()` object whose execution mirrors the
 * ForgeRoom DSL semantics. This module builds STRUCTURE and step-body data flow
 * only. The real AgentRunner / CheckRunner / Conductor are NOT called here; they
 * are injected as collaborators via {@link AdapterContext} and invoked from the
 * step bodies this adapter constructs. #8 (pipeline) and #7 (conductor) supply
 * the concrete collaborators; this adapter defines the seam.
 *
 * Wire order (ADR-016): WorkflowRegistry.load -> workflow-parser ->
 * adapter.validate (here, throws {@link AdapterValidationError}) -> Mastra build.
 */
import { createHash } from 'node:crypto';

import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

import type { IntentRegistry } from '../core/intent-registry.js';
import { parseWorkflowConfig } from './workflow-parser.js';
import { AdapterValidationError } from './dsl-errors.js';

// ---------------------------------------------------------------------------
// Parsed ForgeRoom workflow shape (typed view over the generic parser output)
// ---------------------------------------------------------------------------

export interface WorkflowEffects {
  worktree: 'read_only' | 'modifies';
  external: {
    report: 'none' | 'status' | 'final';
    pr: 'none' | 'draft' | 'ready';
  };
}

/** An Executable Step (`type: run`, or a review_loop's review/refine spec). */
export interface ParsedRunStep {
  type: 'run';
  id: string;
  intent: string;
  prompt_template: string;
  input_refs: Record<string, string>;
  vars: Record<string, string>;
  /** Output selectors to parse in the body, e.g. ['slices']. */
  output_selectors: SelectorName[];
  pause_after: boolean;
}

/** Executable spec used inside a review_loop (no `type`, no `pause_after`). */
export interface ParsedExecutableSpec {
  id: string;
  intent: string;
  prompt_template: string;
  input_refs: Record<string, string>;
  vars: Record<string, string>;
}

export interface ParsedGroupStep {
  type: 'group';
  id: string;
  foreach: string;
  as: string;
  steps: ParsedRunStep[];
}

export interface ParsedReviewLoopStep {
  type: 'review_loop';
  id: string;
  until: string;
  max_iterations: number;
  review: ParsedExecutableSpec;
  refine: ParsedExecutableSpec;
}

export type ParsedStep = ParsedRunStep | ParsedGroupStep | ParsedReviewLoopStep;

export interface ParsedForgeWorkflow {
  id: string;
  description: string;
  effects: WorkflowEffects;
  steps: ParsedStep[];
}

export type SelectorName = 'slices';

// ---------------------------------------------------------------------------
// Adapter context: interpolation source + injected collaborators + selectors
// ---------------------------------------------------------------------------

/** Resolved Step metadata (Intent + Step Harness composed at build time). */
export interface ResolvedStep {
  /** Mastra step id: `${intent_id}:${step_id}`. */
  mastraStepId: string;
  stepId: string;
  intentId: string;
  kind: string;
  agent: string;
  harness: string;
  promptTemplate: string;
  /** Raw (uninterpolated) vars from the DSL, evaluated at bind time. */
  vars: Record<string, string>;
  /** Raw (uninterpolated) input_refs from the DSL, evaluated at bind time. */
  input_refs: Record<string, string>;
}

/** Variables made available to `${...}` interpolation. */
export interface InterpolationSource {
  task: {
    title: string;
    description: string;
    project: string;
    branch: string;
    worktree_path: string;
    issue_number: string;
    full_diff_path: string;
    final_slices: string[];
  };
  vars: Record<string, string>;
  /** Prior step outputs keyed by step id (filled by the pipeline at runtime). */
  stepOutputs: Record<string, StepOutputView>;
}

export interface StepOutputView {
  output?: string;
  output_path?: string;
  diff_path?: string | null;
  passed?: boolean;
  slices?: string[];
}

/** Values produced by interpolating a step's vars / input_refs. */
export interface InterpolatedInputs {
  vars: Record<string, unknown>;
  input_refs: Record<string, unknown>;
}

export interface AgentRunResult {
  outputPath: string;
  output: string;
  diffPath: string | null;
}

/**
 * The collaborators the step bodies call. Concrete implementations are wired by
 * #8 / #7; tests pass fakes. The adapter only orchestrates call ORDER.
 */
export interface AdapterCollaborators {
  renderPrompt(resolved: ResolvedStep, inputs: InterpolatedInputs): Promise<string>;
  runAgent(resolved: ResolvedStep, promptPath: string, inputs: InterpolatedInputs): Promise<AgentRunResult>;
  runChecks(resolved: ResolvedStep, run: AgentRunResult): Promise<{ allPassed: boolean }>;
  saveDiff(resolved: ResolvedStep, run: AgentRunResult): Promise<string | null>;
  conductorUpdate(resolved: ResolvedStep, run: AgentRunResult): Promise<void>;
  /** Called from the dedicated pauseAfterGate step (suspend lives in the gate). */
  suspend(resolved: ResolvedStep): Promise<void>;
}

export interface SelectorParsers {
  parseSlices(output: string): string[];
  parseReviewPassed(output: string): boolean;
}

export interface AdapterContext {
  interpolation: InterpolationSource;
  collaborators: AdapterCollaborators;
  selectors: SelectorParsers;
}

// ---------------------------------------------------------------------------
// Step execution output shape (what every worker step body returns)
// ---------------------------------------------------------------------------

/**
 * The output shape every worker step body returns. Parsed selector values
 * (`slices`, `passed`) live here so they flow into `.dountil()` conditions and
 * downstream `.then()` steps without re-parsing (ADR-016 "Output selector 위치").
 */
export interface StepExecution {
  stepId: string;
  outputPath: string;
  diffPath: string | null;
  /** Threaded review-loop iteration (OQ-M01: not exposed natively by Mastra). */
  iteration: number;
  passed: boolean;
  slices: string[] | null;
}

const stepExecutionSchema = z.object({
  stepId: z.string(),
  outputPath: z.string(),
  diffPath: z.string().nullable(),
  iteration: z.number(),
  passed: z.boolean(),
  slices: z.array(z.string()).nullable(),
});

const loopStateSchema = z.object({
  stepId: z.string(),
  outputPath: z.string(),
  diffPath: z.string().nullable(),
  iteration: z.number(),
  passed: z.boolean(),
  slices: z.array(z.string()).nullable(),
});

export interface BuiltMastraWorkflow {
  // The committed Mastra workflow object. `unknown`-ish at the boundary because
  // each workflow has a distinct generic shape; the pipeline registers it with
  // Mastra by name.
  workflow: ReturnType<ReturnType<typeof createWorkflow>['commit']>;
  effects: WorkflowEffects;
  /** Resolved step metadata, in declaration order, for Registry/Reporter use. */
  resolvedSteps: ResolvedStep[];
}

// ---------------------------------------------------------------------------
// Public: parse a single named workflow out of yaml
// ---------------------------------------------------------------------------

export function parseForgeWorkflow(source: string, workflowId: string): ParsedForgeWorkflow {
  const { config } = parseWorkflowConfig(source, { source: workflowId });
  const raw = config[workflowId];
  if (raw === undefined) {
    throw new AdapterValidationError(`workflow not found in source`, workflowId);
  }
  return normalizeWorkflow(workflowId, raw);
}

function normalizeWorkflow(id: string, raw: Record<string, unknown>): ParsedForgeWorkflow {
  const effects = normalizeEffects(id, raw.effects);
  const rawSteps = raw.steps;
  if (!Array.isArray(rawSteps)) {
    throw new AdapterValidationError('workflow.steps must be a list', id, 'steps');
  }
  const steps = rawSteps.map((s, i) => normalizeStep(id, s, `steps[${String(i)}]`));
  return {
    id,
    description: typeof raw.description === 'string' ? raw.description : '',
    effects,
    steps,
  };
}

function normalizeEffects(id: string, raw: unknown): WorkflowEffects {
  if (!isRecord(raw)) {
    throw new AdapterValidationError('workflow.effects must be a mapping', id, 'effects');
  }
  const external = isRecord(raw.external) ? raw.external : {};
  return {
    worktree: raw.worktree === 'modifies' ? 'modifies' : 'read_only',
    external: {
      report: oneOf(external.report, ['none', 'status', 'final'], 'none'),
      pr: oneOf(external.pr, ['none', 'draft', 'ready'], 'none'),
    },
  };
}

function normalizeStep(workflowId: string, raw: unknown, field: string): ParsedStep {
  if (!isRecord(raw)) {
    throw new AdapterValidationError('step must be a mapping', workflowId, field);
  }
  const type = raw.type;
  if (type === 'group') {
    return {
      type: 'group',
      id: requireStringField(workflowId, raw.id, `${field}.id`),
      foreach: requireStringField(workflowId, raw.foreach, `${field}.foreach`),
      as: requireStringField(workflowId, raw.as, `${field}.as`),
      steps: Array.isArray(raw.steps)
        ? raw.steps.map((s, i) => normalizeRunStep(workflowId, s, `${field}.steps[${String(i)}]`))
        : (() => {
            throw new AdapterValidationError('group.steps must be a list', workflowId, `${field}.steps`);
          })(),
    };
  }
  if (type === 'review_loop') {
    return {
      type: 'review_loop',
      id: requireStringField(workflowId, raw.id, `${field}.id`),
      until: requireStringField(workflowId, raw.until, `${field}.until`),
      max_iterations: requireNumberField(workflowId, raw.max_iterations, `${field}.max_iterations`),
      review: normalizeExecutableSpec(workflowId, raw.review, `${field}.review`),
      refine: normalizeExecutableSpec(workflowId, raw.refine, `${field}.refine`),
    };
  }
  if (type === 'run') {
    return normalizeRunStep(workflowId, raw, field);
  }
  throw new AdapterValidationError(`unknown step type: ${String(type)}`, workflowId, `${field}.type`);
}

function normalizeRunStep(workflowId: string, raw: unknown, field: string): ParsedRunStep {
  if (!isRecord(raw) || raw.type !== 'run') {
    throw new AdapterValidationError('expected a `type: run` step', workflowId, field);
  }
  return {
    type: 'run',
    id: requireStringField(workflowId, raw.id, `${field}.id`),
    intent: requireStringField(workflowId, raw.intent, `${field}.intent`),
    prompt_template: typeof raw.prompt_template === 'string' ? raw.prompt_template : '',
    input_refs: normalizeStringMap(raw.input_refs),
    vars: normalizeStringMap(raw.vars),
    output_selectors: normalizeSelectors(raw.output_selectors),
    pause_after: raw.pause_after === true,
  };
}

function normalizeExecutableSpec(workflowId: string, raw: unknown, field: string): ParsedExecutableSpec {
  if (!isRecord(raw)) {
    throw new AdapterValidationError('expected an executable spec mapping', workflowId, field);
  }
  return {
    id: requireStringField(workflowId, raw.id, `${field}.id`),
    intent: requireStringField(workflowId, raw.intent, `${field}.intent`),
    prompt_template: typeof raw.prompt_template === 'string' ? raw.prompt_template : '',
    input_refs: normalizeStringMap(raw.input_refs),
    vars: normalizeStringMap(raw.vars),
  };
}

// ---------------------------------------------------------------------------
// Public: build the Mastra workflow (validate -> compile)
// ---------------------------------------------------------------------------

export function toMastraWorkflow(
  parsed: ParsedForgeWorkflow,
  intents: IntentRegistry,
  ctx: AdapterContext,
): BuiltMastraWorkflow {
  validateWorkflow(parsed, intents);

  const resolvedSteps: ResolvedStep[] = [];
  const resolve: ResolveFn = (spec): ResolvedStep => {
    const intent = intents.resolve(spec.intent);
    const r: ResolvedStep = {
      mastraStepId: `${spec.intent}:${spec.id}`,
      stepId: spec.id,
      intentId: spec.intent,
      kind: intent.kind,
      agent: intent.agent,
      harness: intent.harness,
      promptTemplate: spec.prompt_template,
      vars: spec.vars,
      input_refs: spec.input_refs,
    };
    resolvedSteps.push(r);
    return r;
  };

  let wf = createWorkflow({
    id: sanitizeWorkflowId(parsed.id),
    inputSchema: z.object({}).passthrough(),
    outputSchema: z.unknown(),
  });

  for (const step of parsed.steps) {
    if (step.type === 'run') {
      wf = appendRunStep(wf, step, ctx, resolve);
    } else if (step.type === 'group') {
      wf = appendForeach(wf, step, ctx, resolve);
    } else {
      wf = appendReviewLoop(wf, step, ctx, resolve);
    }
  }

  return {
    workflow: wf.commit(),
    effects: parsed.effects,
    resolvedSteps,
  };
}

// The adapter composes heterogeneous workflow shapes; Mastra's chaining methods
// return progressively-narrowed generic types that cannot be expressed as one
// reusable alias. We deliberately treat the in-progress builder as `any` and
// re-impose type safety at the public boundary (BuiltMastraWorkflow).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyWf = any;
interface ResolvableSpec {
  id: string;
  intent: string;
  prompt_template: string;
  vars: Record<string, string>;
  input_refs: Record<string, string>;
}
type ResolveFn = (spec: ResolvableSpec) => ResolvedStep;

// ---------------------------------------------------------------------------
// Sequential `type: run` -> `.then(step)` (+ optional pauseAfterGate)
// ---------------------------------------------------------------------------

function appendRunStep(wf: AnyWf, step: ParsedRunStep, ctx: AdapterContext, resolve: ResolveFn): AnyWf {
  const resolved = resolve(step);
  const worker = buildWorkerStep(resolved, step, ctx);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let next = (wf as any).then(worker) as AnyWf;
  if (step.pause_after) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    next = (next as any).then(buildPauseGate(resolved, ctx)) as AnyWf;
  }
  return next;
}

/**
 * A worker step body runs, in ADR-016 order:
 * render prompt -> AgentRunner.run -> output/selector validation ->
 * CheckRunner (kind: execute only) -> diff save -> Conductor.update.
 * Selector values are parsed here and returned in the output (so they flow on).
 */
function buildWorkerStep(
  resolved: ResolvedStep,
  step: ParsedRunStep,
  ctx: AdapterContext,
): ReturnType<typeof createStep> {
  return createStep({
    id: resolved.mastraStepId,
    inputSchema: z.unknown(),
    outputSchema: stepExecutionSchema,
    execute: async (): Promise<StepExecution> => runWorkerBody(resolved, step.output_selectors, ctx, 0),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

async function runWorkerBody(
  resolved: ResolvedStep,
  selectors: SelectorName[],
  ctx: AdapterContext,
  iteration: number,
  varsOverride?: Record<string, unknown>,
): Promise<StepExecution> {
  const inputs = interpolateInputs(resolved, ctx, varsOverride);
  const promptPath = await ctx.collaborators.renderPrompt(resolved, inputs);
  const run = await ctx.collaborators.runAgent(resolved, promptPath, inputs);

  // Output selector validation INSIDE the body (ADR-016).
  let slices: string[] | null = null;
  if (selectors.includes('slices')) {
    slices = ctx.selectors.parseSlices(run.output);
  }
  const passed = resolved.kind === 'review' ? ctx.selectors.parseReviewPassed(run.output) : false;

  // CheckRunner only for kind: execute (ADR-016 / pipeline-engine.md).
  if (resolved.kind === 'execute') {
    await ctx.collaborators.runChecks(resolved, run);
  }

  const diffPath = await ctx.collaborators.saveDiff(resolved, run);
  await ctx.collaborators.conductorUpdate(resolved, run);

  return {
    stepId: resolved.stepId,
    outputPath: run.outputPath,
    diffPath: diffPath ?? run.diffPath,
    iteration,
    passed,
    slices,
  };
}

/** The dedicated pause gate: suspend lives here, not in the worker body. */
function buildPauseGate(resolved: ResolvedStep, ctx: AdapterContext): ReturnType<typeof createStep> {
  return createStep({
    id: `${resolved.mastraStepId}:pauseAfterGate`,
    inputSchema: stepExecutionSchema,
    outputSchema: stepExecutionSchema,
    resumeSchema: z.object({ resumed: z.boolean() }),
    suspendSchema: z.object({ stepId: z.string() }),
    execute: async ({ inputData, resumeData, suspend }) => {
      const resume = resumeData as { resumed?: boolean } | undefined;
      if (!resume?.resumed) {
        await ctx.collaborators.suspend(resolved);
        return (await suspend({ stepId: resolved.stepId })) as never;
      }
      return inputData;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

// ---------------------------------------------------------------------------
// `type: group` + foreach -> `.foreach(step, { concurrency: 1 })`
// ---------------------------------------------------------------------------

function appendForeach(wf: AnyWf, step: ParsedGroupStep, ctx: AdapterContext, resolve: ResolveFn): AnyWf {
  // The foreach list expression is RESOLVED LAZILY at iteration bind time
  // (ADR-016 "bind time" = step input bind at runtime, NOT workflow build).
  // MVP only supports `${task.final_slices}` and `${<step>.output.slices}`.
  // We capture only the expression (HOW to get the list), never a build-time
  // array snapshot (WHAT it currently is): the prior plan/review step fills the
  // runtime interpolation source, and the list step reads it when it executes.
  const listExpr = step.foreach.trim();
  // Fail fast at build time on an unsupported expression SHAPE, while the VALUE
  // is still resolved lazily at runtime (the shape is run-independent).
  assertForeachExprSupported(listExpr, step);

  // Compose the group's inner steps (worker + optional pause gate per item)
  // into a single nested committed workflow, which `.foreach()` accepts as a
  // Step (codex-verified for @mastra/core 1.36).
  const innerStep = buildForeachItemStep(step, ctx, resolve);

  // The list step resolves the array at RUNTIME from the (current) runtime
  // interpolation source, then `.foreach()` iterates that returned array.
  // Reading lazily here means a cached/reused built workflow never carries a
  // stale build-time array between runs (issue #20).
  const listStep = createStep({
    id: `${step.id}:items`,
    inputSchema: z.unknown(),
    outputSchema: z.array(z.string()),
    execute: async (): Promise<string[]> => evaluateForeachList(listExpr, ctx, step),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (wf as any).then(listStep).foreach(innerStep, { concurrency: 1 }) as AnyWf;
}

function buildForeachItemStep(
  step: ParsedGroupStep,
  ctx: AdapterContext,
  resolve: ResolveFn,
): ReturnType<typeof createStep> {
  // Resolve all inner steps up front for metadata; bodies bind `as` from input.
  const inner = step.steps.map((s) => ({
    spec: s,
    resolved: resolve(s),
  }));

  return createStep({
    id: `${step.id}:item`,
    inputSchema: z.string(),
    outputSchema: z.array(stepExecutionSchema),
    execute: async ({ inputData, suspend, resumeData }): Promise<StepExecution[]> => {
      const item = inputData;
      const results: StepExecution[] = [];
      for (const { spec, resolved } of inner) {
        const varsOverride: Record<string, unknown> = { [step.as]: item };
        const exec = await runWorkerBody(resolved, spec.output_selectors, ctx, 0, varsOverride);
        results.push(exec);
        if (spec.pause_after) {
          const resume = resumeData as { resumed?: boolean } | undefined;
          if (!resume?.resumed) {
            await ctx.collaborators.suspend(resolved);
            return (await suspend({ stepId: resolved.stepId })) as never;
          }
        }
      }
      return results;
    },
    suspendSchema: z.object({ stepId: z.string() }),
    resumeSchema: z.object({ resumed: z.boolean() }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

const FOREACH_STEP_SLICES_RE = /^\$\{(\w+)\.output\.slices\}$/;

/**
 * Build-time guard: reject an unsupported foreach expression SHAPE up front, so
 * a malformed workflow still fails at adapter build (ADR-016 validation), not
 * mid-run. The VALUE behind a supported shape is resolved lazily at runtime by
 * {@link evaluateForeachList}.
 */
function assertForeachExprSupported(expr: string, step: ParsedGroupStep): void {
  if (expr === '${task.final_slices}' || FOREACH_STEP_SLICES_RE.test(expr)) {
    return;
  }
  throw new AdapterValidationError(`unsupported foreach expression: ${expr}`, step.id, 'foreach');
}

/**
 * Resolve the foreach list at RUNTIME from the current interpolation source.
 * Called from the list step's `execute()` (iteration bind time), so it always
 * reads the run's own slices — never a build-time snapshot. MVP supports
 * `${task.final_slices}` and `${<step>.output.slices}`.
 */
function evaluateForeachList(expr: string, ctx: AdapterContext, step: ParsedGroupStep): string[] {
  if (expr === '${task.final_slices}') {
    return ctx.interpolation.task.final_slices;
  }
  const m = FOREACH_STEP_SLICES_RE.exec(expr);
  if (m) {
    const view = ctx.interpolation.stepOutputs[m[1] as string];
    return view?.slices ?? [];
  }
  // Unreachable: assertForeachExprSupported rejects unsupported shapes at build.
  throw new AdapterValidationError(`unsupported foreach expression: ${expr}`, step.id, 'foreach');
}

// ---------------------------------------------------------------------------
// `type: review_loop` -> `.dountil(loopStep, condition)`
// ---------------------------------------------------------------------------

function appendReviewLoop(
  wf: AnyWf,
  step: ParsedReviewLoopStep,
  ctx: AdapterContext,
  resolve: ResolveFn,
): AnyWf {
  const reviewResolved = resolve(step.review);
  const refineResolved = resolve(step.refine);
  const maxIterations = step.max_iterations;

  // Seed step: provides the initial loop state (iteration 0, not passed).
  const seedStep = createStep({
    id: `${step.id}:seed`,
    inputSchema: z.unknown(),
    outputSchema: loopStateSchema,
    execute: async (): Promise<StepExecution> => ({
      stepId: step.id,
      outputPath: '',
      diffPath: null,
      iteration: 0,
      passed: false,
      slices: null,
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  const loopStep = createStep({
    id: `${step.id}:loop`,
    inputSchema: loopStateSchema,
    outputSchema: loopStateSchema,
    execute: async ({ inputData }): Promise<StepExecution> => {
      const state = inputData as StepExecution;
      // iteration 0 = initial review only (no refine). Each subsequent entry
      // runs refine first, then review.
      if (state.iteration > 0) {
        await runWorkerBody(refineResolved, [], ctx, state.iteration);
      }
      const reviewExec = await runWorkerBody(reviewResolved, [], ctx, state.iteration);
      return { ...reviewExec, iteration: state.iteration + 1, stepId: step.id };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  // Condition (dountil): loop STOPS when it returns true.
  // `iterationCount` is the 1-based count of loopStep executions (codex-verified
  // against Mastra source). After execution N, refine cycles done = N - 1.
  // Stop when review passed, OR when the refine budget is exhausted. We do NOT
  // throw here: a throw in the condition rejects the run rather than producing a
  // clean `status: 'failed'`. Instead the loop stops with `passed: false` and a
  // trailing verify step fails the run with review_loop_max_iterations.
  const condition = async ({
    inputData,
    iterationCount,
  }: {
    inputData: StepExecution;
    iterationCount: number;
  }): Promise<boolean> => {
    if (inputData.passed) return true;
    const refineCyclesDone = iterationCount - 1;
    return refineCyclesDone >= maxIterations;
  };

  const verifyStep = createStep({
    id: `${step.id}:verify`,
    inputSchema: loopStateSchema,
    outputSchema: loopStateSchema,
    execute: async ({ inputData }): Promise<StepExecution> => {
      const state = inputData as StepExecution;
      if (!state.passed) {
        throw new ReviewLoopMaxIterationsError(step.id, maxIterations);
      }
      return state;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (wf as any).then(seedStep).dountil(loopStep, condition).then(verifyStep) as AnyWf;
}

/** Surfaced as a run failure; the pipeline maps it to review_loop_max_iterations. */
export class ReviewLoopMaxIterationsError extends Error {
  readonly failure_reason = 'review_loop_max_iterations' as const;
  constructor(
    readonly loopId: string,
    readonly maxIterations: number,
  ) {
    super(`review_loop ${loopId} exhausted max_iterations=${String(maxIterations)}`);
    this.name = 'ReviewLoopMaxIterationsError';
  }
}

// ---------------------------------------------------------------------------
// Interpolation: evaluate ${...} at step input bind time
// ---------------------------------------------------------------------------

function interpolateInputs(
  resolved: ResolvedStep,
  ctx: AdapterContext,
  varsOverride?: Record<string, unknown>,
): InterpolatedInputs {
  const vars: Record<string, unknown> = {};
  for (const [k, expr] of Object.entries(resolved.vars)) {
    vars[k] = evaluateExpression(expr, ctx, varsOverride);
  }
  const input_refs: Record<string, unknown> = {};
  for (const [k, expr] of Object.entries(resolved.input_refs)) {
    input_refs[k] = evaluateExpression(expr, ctx, varsOverride);
  }
  return { vars, input_refs };
}

function evaluateExpression(
  expr: string,
  ctx: AdapterContext,
  varsOverride?: Record<string, unknown>,
): unknown {
  // Whole-string single expression -> return typed value.
  const whole = /^\$\{([^}]+)\}$/.exec(expr.trim());
  if (whole) {
    return resolveRef(whole[1] as string, ctx, varsOverride);
  }
  // Mixed text -> string interpolation.
  return expr.replace(/\$\{([^}]+)\}/g, (_m, ref: string) => {
    const value = resolveRef(ref.trim(), ctx, varsOverride);
    return value === undefined || value === null ? '' : String(value);
  });
}

function resolveRef(ref: string, ctx: AdapterContext, varsOverride?: Record<string, unknown>): unknown {
  const { interpolation } = ctx;

  // foreach `as` binding (e.g. ${slice}).
  if (varsOverride && ref in varsOverride) {
    return varsOverride[ref];
  }

  if (ref.startsWith('vars.')) {
    const name = ref.slice('vars.'.length);
    if (!(name in interpolation.vars)) {
      throw new MissingVariableError(ref);
    }
    return interpolation.vars[name];
  }

  if (ref.startsWith('task.')) {
    const name = ref.slice('task.'.length);
    const task = interpolation.task as unknown as Record<string, unknown>;
    if (!(name in task)) {
      throw new MissingVariableError(ref);
    }
    return task[name];
  }

  // ${<step>.output}, .output_path, .output.slices, .diff_path, .passed
  const stepMatch = /^(\w+)\.(output\.slices|output_path|output|diff_path|passed)$/.exec(ref);
  if (stepMatch) {
    const view = interpolation.stepOutputs[stepMatch[1] as string];
    if (view === undefined) {
      throw new MissingVariableError(ref);
    }
    switch (stepMatch[2]) {
      case 'output.slices':
        return view.slices;
      case 'output_path':
        return view.output_path;
      case 'output':
        return view.output;
      case 'diff_path':
        return view.diff_path;
      case 'passed':
        return view.passed;
      default:
        break;
    }
  }

  throw new MissingVariableError(ref);
}

export class MissingVariableError extends Error {
  constructor(readonly ref: string) {
    super(`missing variable: \${${ref}}`);
    this.name = 'MissingVariableError';
  }
}

// ---------------------------------------------------------------------------
// Validation (ADR-016): unknown intent, missing prompt_template, invalid until
// ---------------------------------------------------------------------------

export function validateWorkflow(parsed: ParsedForgeWorkflow, intents: IntentRegistry): void {
  for (const step of parsed.steps) {
    if (step.type === 'run') {
      validateExecutable(parsed.id, step.id, step.intent, step.prompt_template, intents);
    } else if (step.type === 'group') {
      for (const inner of step.steps) {
        validateExecutable(parsed.id, inner.id, inner.intent, inner.prompt_template, intents);
      }
    } else {
      validateReviewLoop(parsed.id, step, intents);
    }
  }
}

function validateExecutable(
  workflowId: string,
  stepId: string,
  intentId: string,
  promptTemplate: string,
  intents: IntentRegistry,
): void {
  if (!intents.has(intentId)) {
    throw new AdapterValidationError(`unknown intent reference: ${intentId}`, workflowId, `${stepId}.intent`);
  }
  if (promptTemplate.trim() === '') {
    throw new AdapterValidationError('missing prompt_template', workflowId, `${stepId}.prompt_template`);
  }
}

function validateReviewLoop(workflowId: string, step: ParsedReviewLoopStep, intents: IntentRegistry): void {
  validateExecutable(workflowId, step.review.id, step.review.intent, step.review.prompt_template, intents);
  validateExecutable(workflowId, step.refine.id, step.refine.intent, step.refine.prompt_template, intents);

  // until must be exactly ${<review.id>.passed}.
  const expected = `\${${step.review.id}.passed}`;
  if (step.until.trim() !== expected) {
    throw new AdapterValidationError(
      `invalid until expression: expected ${expected}`,
      workflowId,
      `${step.id}.until`,
    );
  }

  // review intent must be kind: review.
  const reviewIntent = intents.resolve(step.review.intent);
  if (reviewIntent.kind !== 'review') {
    throw new AdapterValidationError(
      `review_loop.review intent must be kind: review`,
      workflowId,
      `${step.id}.review.intent`,
    );
  }
}

// ---------------------------------------------------------------------------
// Cache: yaml hash -> built workflow; invalidates on yaml/intents/mastra bump
// ---------------------------------------------------------------------------

export interface CacheKeyParts {
  yamlSource: string;
  intentsSource: string;
  mastraVersion: string;
}

export function adapterCacheKey(parts: CacheKeyParts): string {
  return createHash('sha256')
    .update('forgeroom-adapter ')
    .update(parts.mastraVersion)
    .update(' ')
    .update(parts.intentsSource)
    .update(' ')
    .update(parts.yamlSource)
    .digest('hex');
}

export function buildMastraWorkflowCached(
  parts: CacheKeyParts,
  cache: Map<string, BuiltMastraWorkflow>,
  build: () => BuiltMastraWorkflow,
): BuiltMastraWorkflow {
  const key = adapterCacheKey(parts);
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const built = build();
  cache.set(key, built);
  return built;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function requireStringField(workflowId: string, value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AdapterValidationError(`missing required field`, workflowId, field);
  }
  return value;
}

function requireNumberField(workflowId: string, value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AdapterValidationError(`missing required numeric field`, workflowId, field);
  }
  return value;
}

function normalizeStringMap(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = typeof v === 'string' ? v : String(v);
  }
  return out;
}

function normalizeSelectors(raw: unknown): SelectorName[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is SelectorName => s === 'slices');
}

function sanitizeWorkflowId(id: string): string {
  return id;
}
