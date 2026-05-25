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
 * Wire order (ADR-020): WorkflowRegistry parses/validates/resolves workflows,
 * then this adapter builds Mastra from the resolved workflow tree.
 */
import { createHash } from 'node:crypto';

import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

import { AdapterValidationError, ReviewLoopMaxIterationsError } from '../workflow/errors.js';
import type { WorkflowBuilder } from '../workflow/builder.js';
import type {
  AdapterContext,
  InterpolatedInputs,
  ResolvedWorkflow,
  ResolvedWorkflowExecutableStep,
  ResolvedWorkflowGroupStep,
  ResolvedWorkflowReviewLoopStep,
  ResolvedStep,
  SelectorName,
  WorkflowEffects,
} from '../workflow/types.js';
import {
  parseRuntimeExpressionRef,
  replaceExpressionRefs,
  wholeExpressionRef,
} from '../workflow/expression.js';

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
// Public: build the Mastra workflow
// ---------------------------------------------------------------------------

export function toMastraWorkflow(
  workflow: ResolvedWorkflow,
  ctx: AdapterContext,
): BuiltMastraWorkflow {
  const resolvedStepCache = new WeakMap<ResolvedWorkflowExecutableStep, ResolvedStep>();
  const adapterStepFor = (step: ResolvedWorkflowExecutableStep): ResolvedStep => {
    const cached = resolvedStepCache.get(step);
    if (cached !== undefined) {
      return cached;
    }
    const resolved = toAdapterResolvedStep(step);
    resolvedStepCache.set(step, resolved);
    return resolved;
  };

  let wf = createWorkflow({
    id: sanitizeWorkflowId(workflow.id),
    inputSchema: z.object({}).passthrough(),
    outputSchema: z.unknown(),
  });

  for (const step of workflow.steps) {
    if (step.type === 'run') {
      wf = appendRunStep(wf, step, ctx, adapterStepFor);
    } else if (step.type === 'group') {
      wf = appendForeach(wf, step, ctx, adapterStepFor);
    } else {
      wf = appendReviewLoop(wf, step, ctx, adapterStepFor);
    }
  }

  return {
    workflow: wf.commit(),
    effects: workflow.effects,
    resolvedSteps: workflow.executableSteps.map(adapterStepFor),
  };
}

/**
 * The dsl implementation of core's {@link WorkflowBuilder} port (ADR-022). The
 * composition root injects this into PipelineEngine so core depends on the
 * neutral port, never on this module.
 */
export const mastraWorkflowBuilder: WorkflowBuilder = { build: toMastraWorkflow };

// The adapter composes heterogeneous workflow shapes; Mastra's chaining methods
// return progressively-narrowed generic types that cannot be expressed as one
// reusable alias. We deliberately treat the in-progress builder as `any` and
// re-impose type safety at the public boundary (BuiltMastraWorkflow).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyWf = any;
type AdapterStepFor = (step: ResolvedWorkflowExecutableStep) => ResolvedStep;

function toAdapterResolvedStep(step: ResolvedWorkflowExecutableStep): ResolvedStep {
  return {
    mastraStepId: `${step.intent}:${step.id}`,
    stepId: step.id,
    intentId: step.intent,
    kind: step.kind,
    agent: step.agent,
    harness: step.harness,
    promptTemplate: step.prompt_template,
    vars: step.vars,
    input_refs: step.input_refs,
  };
}

// ---------------------------------------------------------------------------
// Sequential `type: run` -> `.then(step)` (+ optional pauseAfterGate)
// ---------------------------------------------------------------------------

function appendRunStep(
  wf: AnyWf,
  step: ResolvedWorkflowExecutableStep,
  ctx: AdapterContext,
  adapterStepFor: AdapterStepFor,
): AnyWf {
  const resolved = adapterStepFor(step);
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
  step: ResolvedWorkflowExecutableStep,
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

function appendForeach(
  wf: AnyWf,
  step: ResolvedWorkflowGroupStep,
  ctx: AdapterContext,
  adapterStepFor: AdapterStepFor,
): AnyWf {
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
  const innerStep = buildForeachItemStep(step, ctx, adapterStepFor);

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
  step: ResolvedWorkflowGroupStep,
  ctx: AdapterContext,
  adapterStepFor: AdapterStepFor,
): ReturnType<typeof createStep> {
  // Resolve all inner steps up front for metadata; bodies bind `as` from input.
  const inner = step.steps.map((s) => ({
    spec: s,
    resolved: adapterStepFor(s),
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
function assertForeachExprSupported(expr: string, step: ResolvedWorkflowGroupStep): void {
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
function evaluateForeachList(expr: string, ctx: AdapterContext, step: ResolvedWorkflowGroupStep): string[] {
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
  step: ResolvedWorkflowReviewLoopStep,
  ctx: AdapterContext,
  adapterStepFor: AdapterStepFor,
): AnyWf {
  const reviewResolved = adapterStepFor(step.review);
  const refineResolved = adapterStepFor(step.refine);
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
  const whole = wholeExpressionRef(expr);
  if (whole !== null) {
    return resolveRef(whole, ctx, varsOverride);
  }
  // Mixed text -> string interpolation.
  return replaceExpressionRefs(expr, (ref) => {
    const value = resolveRef(ref, ctx, varsOverride);
    return value === undefined || value === null ? '' : String(value);
  });
}

function resolveRef(ref: string, ctx: AdapterContext, varsOverride?: Record<string, unknown>): unknown {
  const { interpolation } = ctx;
  const parsed = parseRuntimeExpressionRef(ref, new Set(Object.keys(varsOverride ?? {})));

  // foreach `as` binding (e.g. ${slice}).
  if (parsed.kind === 'scoped') {
    return varsOverride?.[parsed.name];
  }

  if (parsed.kind === 'vars') {
    if (!(parsed.name in interpolation.vars)) {
      throw new MissingVariableError(ref);
    }
    return interpolation.vars[parsed.name];
  }

  if (parsed.kind === 'task') {
    const task = interpolation.task as unknown as Record<string, unknown>;
    if (!(parsed.field in task)) {
      throw new MissingVariableError(ref);
    }
    return task[parsed.field];
  }

  // ${<step>.output}, .output_path, .output.slices, .diff_path, .passed
  if (parsed.kind === 'step') {
    const view = interpolation.stepOutputs[parsed.stepId];
    if (view === undefined) {
      throw new MissingVariableError(ref);
    }
    switch (parsed.field) {
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

function sanitizeWorkflowId(id: string): string {
  return id;
}
