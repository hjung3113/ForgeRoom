import { AgentRegistry } from '../agent-runtime/agent-registry.js';
import { HarnessRegistry } from '../agent-runtime/harness-registry.js';
import { IntentRegistry } from './intent-registry.js';
import type {
  ParsedExecutableSpec,
  ParsedForgeWorkflow,
  ParsedGroupStep,
  ParsedReviewLoopStep,
  ParsedRunStep,
  ParsedStep,
  ResolvedWorkflow,
  ResolvedWorkflowExecutableStep,
  ResolvedWorkflowStep,
  WorkflowEffects,
  WorkflowPrEffect,
  WorkflowReportEffect,
  WorkflowWorktreeEffect,
} from '../../workflow/types.js';
import { extractExpressionRefs, parseValidationExpressionRef } from '../../workflow/expression.js';
import { normalizeWorkflow, WorkflowSchemaError } from '../../workflow/schema.js';

export type { WorkflowEffects, WorkflowPrEffect, WorkflowReportEffect, WorkflowWorktreeEffect };

export class WorkflowValidationError extends Error {
  readonly workflowId: string | null;
  readonly field: string | null;
  readonly sourceContext: WorkflowValidationSourceContext | undefined;

  constructor(message: string, options: WorkflowValidationErrorOptions = {}) {
    super(message);
    this.name = 'WorkflowValidationError';
    this.workflowId = options.workflowId ?? null;
    this.field = options.field ?? null;
    this.sourceContext = options.sourceContext;
  }
}

interface WorkflowValidationErrorOptions {
  workflowId?: string;
  field?: string;
  sourceContext?: WorkflowValidationSourceContext;
}

export type ParsedWorkflow = Omit<ResolvedWorkflow, 'executableSteps'> & {
  executableSteps?: ResolvedExecutableStep[];
};
export type ResolvedStep = ResolvedWorkflowStep;
export type ResolvedExecutableStep = ResolvedWorkflowExecutableStep;

interface RegistryDeps {
  intentRegistry: IntentRegistry;
  agentRegistry: AgentRegistry;
  harnessRegistry: HarnessRegistry;
}

export interface WorkflowRegistryOptions {
  templateExists?: (relativePath: string) => boolean;
  referencedWorkflowIds?: Iterable<string>;
  sourceMap?: WorkflowValidationSourceMap;
}

export interface DisabledWorkflow {
  id: string;
  error: string;
}

export interface WorkflowValidationSourceLocation {
  line: number;
  column: number;
}

export interface WorkflowValidationSourceMap {
  source?: string;
  workflows: Record<
    string,
    {
      id?: WorkflowValidationSourceLocation;
      fields: Record<string, WorkflowValidationSourceLocation>;
    }
  >;
}

export interface WorkflowValidationSourceContext {
  source: string;
  workflowId: string;
  field: string;
  location: WorkflowValidationSourceLocation | null;
}

interface RawWorkflow {
  description?: unknown;
  effects?: unknown;
  steps?: unknown;
}

interface RawStep {
  type?: unknown;
  id?: unknown;
  intent?: unknown;
  prompt_template?: unknown;
  input_refs?: unknown;
  vars?: unknown;
  pause_after?: unknown;
  foreach?: unknown;
  as?: unknown;
  steps?: unknown;
  review?: unknown;
  refine?: unknown;
  until?: unknown;
  max_iterations?: unknown;
  agent?: unknown;
  kind?: unknown;
  harness?: unknown;
  prompt?: unknown;
}

export class WorkflowRegistry {
  private constructor(
    private readonly workflows: Map<string, ParsedWorkflow>,
    private readonly disabled: DisabledWorkflow[],
  ) {}

  static fromConfig(
    config: Record<string, RawWorkflow>,
    deps: RegistryDeps,
    options: WorkflowRegistryOptions = {},
  ): WorkflowRegistry {
    const workflows = new Map<string, ParsedWorkflow>();
    const disabled: DisabledWorkflow[] = [];
    const referencedWorkflowIds =
      options.referencedWorkflowIds === undefined ? null : new Set(options.referencedWorkflowIds);

    for (const [id, raw] of Object.entries(config)) {
      if (id.trim() === '') {
        throw new WorkflowValidationError('workflow id must not be empty');
      }

      try {
        const workflow = resolveWorkflow(id, raw, deps, options);
        workflows.set(id, workflow);
      } catch (error) {
        const enrichedError = enrichWorkflowValidationError(id, error, options.sourceMap);
        if (referencedWorkflowIds === null || referencedWorkflowIds.has(id)) {
          throw enrichedError;
        }
        disabled.push({
          id,
          error: enrichedError.message,
        });
      }
    }

    return new WorkflowRegistry(workflows, disabled);
  }

  get(workflowId: string): ParsedWorkflow | null {
    return this.workflows.get(workflowId) ?? null;
  }

  has(workflowId: string): boolean {
    return this.workflows.has(workflowId);
  }

  list(): ParsedWorkflow[] {
    return [...this.workflows.values()];
  }

  listDisabled(): DisabledWorkflow[] {
    return [...this.disabled];
  }
}

function enrichWorkflowValidationError(
  workflowId: string,
  error: unknown,
  sourceMap: WorkflowValidationSourceMap | undefined,
): Error {
  if (!(error instanceof WorkflowValidationError) || sourceMap === undefined) {
    return error instanceof Error ? error : new WorkflowValidationError(String(error));
  }

  const field = error.field;
  if (field === null) {
    return error;
  }

  const validationWorkflowId = error.workflowId ?? workflowId;
  const workflowSource = sourceMap.workflows[validationWorkflowId];
  const location = workflowSourceLocation(workflowSource, field);
  const sourceContext = {
    source: sourceMap.source ?? '<workflow-yaml>',
    workflowId: validationWorkflowId,
    field,
    location,
  };
  const locationMessage =
    location === null ? '' : ` line ${String(location.line)} column ${String(location.column)}`;

  return new WorkflowValidationError(
    `workflow ${validationWorkflowId} field ${field}${locationMessage}: ${error.message}`,
    { workflowId: validationWorkflowId, field, sourceContext },
  );
}

function workflowSourceLocation(
  workflowSource: WorkflowValidationSourceMap['workflows'][string] | undefined,
  field: string,
): WorkflowValidationSourceLocation | null {
  if (workflowSource === undefined) {
    return null;
  }

  let candidate: string | null = field;
  while (candidate !== null) {
    const location = workflowSource.fields[candidate];
    if (location !== undefined) {
      return location;
    }
    candidate = parentField(candidate);
  }

  return workflowSource.id ?? null;
}

function parentField(field: string): string | null {
  const dotIndex = field.lastIndexOf('.');
  if (dotIndex === -1) {
    return null;
  }

  return field.slice(0, dotIndex);
}

function resolveWorkflow(
  id: string,
  raw: RawWorkflow,
  deps: RegistryDeps,
  options: WorkflowRegistryOptions,
): ParsedWorkflow {
  validateRawWorkflow(id, raw);
  const parsed = normalizeConfigWorkflow(id, raw);
  if (parsed.steps.length === 0) {
    throw new WorkflowValidationError(`workflow ${id}.steps must be a non-empty array`, {
      workflowId: id,
      field: 'steps',
    });
  }
  const knownStepIds = collectStepIds(parsed.steps, id);
  const executableSteps: ResolvedExecutableStep[] = [];
  const workflow: ParsedWorkflow = {
    id: parsed.id,
    description: parsed.description,
    effects: resolveEffects(raw.effects, id),
    steps: parsed.steps.map((step, index) =>
      resolveStep(step, deps, options, {
        workflowId: id,
        path: `steps[${String(index)}]`,
        executableSteps,
      }),
    ),
    executableSteps,
  };
  validateWorkflowReferences(workflow, knownStepIds);

  return workflow;
}

function normalizeConfigWorkflow(id: string, raw: RawWorkflow): ParsedForgeWorkflow {
  try {
    return normalizeWorkflow(id, raw as Record<string, unknown>);
  } catch (error) {
    if (error instanceof WorkflowSchemaError) {
      throw new WorkflowValidationError(error.message, { workflowId: error.workflowId, field: error.field ?? undefined });
    }
    throw error;
  }
}

function validateRawWorkflow(workflowId: string, raw: RawWorkflow): void {
  validateRawEffects(raw.effects, workflowId);
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    throw new WorkflowValidationError(`workflow ${workflowId}.steps must be a non-empty array`, {
      workflowId,
      field: 'steps',
    });
  }
  raw.steps.forEach((step, index) => {
    validateRawStep(asRawStep(step, `${workflowId}.steps[${String(index)}]`, `steps[${String(index)}]`, workflowId), {
      workflowId,
      path: `steps[${String(index)}]`,
    });
  });
}

function validateRawStep(raw: RawStep, context: Omit<StepParseContext, 'executableSteps'>): void {
  if (raw.type === 'run') {
    validateRawExecutableStep(raw, context);
    return;
  }
  if (raw.type === 'group') {
    if (raw.intent !== undefined || raw.prompt_template !== undefined || raw.prompt !== undefined) {
      throw new WorkflowValidationError('group step cannot define intent, prompt_template, or prompt', {
        workflowId: context.workflowId,
        field: context.path,
      });
    }
    if (Array.isArray(raw.steps)) {
      raw.steps.forEach((step, index) => {
        validateRawStep(
          asRawStep(
            step,
            `${String(raw.id)}.steps[${String(index)}]`,
            `${context.path}.steps[${String(index)}]`,
            context.workflowId,
          ),
          {
            workflowId: context.workflowId,
            path: `${context.path}.steps[${String(index)}]`,
          },
        );
      });
    }
    return;
  }
  if (raw.type === 'review_loop') {
    validateRawExecutableStep(
      asRawStep(raw.review, `review_loop ${String(raw.id)}.review`, `${context.path}.review`, context.workflowId),
      {
        workflowId: context.workflowId,
        path: `${context.path}.review`,
      },
    );
    validateRawExecutableStep(
      asRawStep(raw.refine, `review_loop ${String(raw.id)}.refine`, `${context.path}.refine`, context.workflowId),
      {
        workflowId: context.workflowId,
        path: `${context.path}.refine`,
      },
    );
  }
}

function validateRawExecutableStep(raw: RawStep, context: Omit<StepParseContext, 'executableSteps'>): void {
  for (const field of ['agent', 'kind', 'harness', 'prompt'] as const) {
    if (raw[field] !== undefined) {
      throw new WorkflowValidationError(`executable step cannot define ${field}`, {
        workflowId: context.workflowId,
        field: `${context.path}.${field}`,
      });
    }
  }
  validateRawStringRecord(raw.input_refs, `${context.path}.input_refs`, context.workflowId);
  validateRawStringRecord(raw.vars, `${context.path}.vars`, context.workflowId);
}

function validateRawStringRecord(value: unknown, field: string, workflowId: string): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    throw new WorkflowValidationError('expected string record', { workflowId, field });
  }
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') {
      throw new WorkflowValidationError(`expected string value for ${key}`, {
        workflowId,
        field: `${field}.${key}`,
      });
    }
  }
}

function validateRawEffects(raw: unknown, workflowId: string): void {
  if (!isRecord(raw)) {
    throw new WorkflowValidationError(`workflow ${workflowId}.effects is required`, {
      workflowId,
      field: 'effects',
    });
  }
  const external = raw.external;
  if (!isRecord(external)) {
    throw new WorkflowValidationError(`workflow ${workflowId}.effects.external is required`, {
      workflowId,
      field: 'effects.external',
    });
  }
  requireOneOf(
    raw.worktree,
    ['read_only', 'modifies'],
    `${workflowId}.effects.worktree`,
    'effects.worktree',
    workflowId,
  );
  requireOneOf(
    external.report,
    ['none', 'status', 'final'],
    `${workflowId}.effects.external.report`,
    'effects.external.report',
    workflowId,
  );
  requireOneOf(
    external.pr,
    ['none', 'draft', 'ready'],
    `${workflowId}.effects.external.pr`,
    'effects.external.pr',
    workflowId,
  );
}

function resolveEffects(raw: unknown, workflowId: string): WorkflowEffects {
  validateRawEffects(raw, workflowId);
  const effectRaw = raw as { worktree: WorkflowEffects['worktree']; external: WorkflowEffects['external'] };
  return {
    worktree: effectRaw.worktree,
    external: {
      report: effectRaw.external.report,
      pr: effectRaw.external.pr,
    },
  };
}

interface StepParseContext {
  workflowId: string;
  path: string;
  executableSteps: ResolvedExecutableStep[];
}

const STEP_SOURCE_PATHS = new WeakMap<ResolvedStep, string>();

function resolveStep(
  step: ParsedStep,
  deps: RegistryDeps,
  options: WorkflowRegistryOptions,
  context: StepParseContext,
): ResolvedStep {
  if (step.type === 'run') {
    return resolveExecutableStep(step, deps, options, context);
  }
  if (step.type === 'group') {
    return resolveGroupStep(step, deps, options, context);
  }

  return resolveReviewLoopStep(step, deps, options, context);
}

function resolveExecutableStep(
  spec: ParsedRunStep | ParsedExecutableSpec,
  deps: RegistryDeps,
  options: WorkflowRegistryOptions,
  context: StepParseContext,
): ResolvedExecutableStep {
  const id = spec.id;
  const intentId = spec.intent;
  const promptTemplate = validatePromptTemplate(
    spec.prompt_template,
    options,
    `${context.path}.prompt_template`,
    context.workflowId,
  );
  const intent = deps.intentRegistry.resolve(intentId);
  const agent = deps.agentRegistry.resolve(intent.agent);
  deps.harnessRegistry.resolve(intent.harness);

  const step: ResolvedExecutableStep = {
    type: 'run',
    id,
    intent: intentId,
    prompt_template: promptTemplate,
    input_refs: spec.input_refs,
    vars: spec.vars,
    output_selectors: 'output_selectors' in spec ? spec.output_selectors : [],
    pause_after: 'pause_after' in spec ? spec.pause_after : false,
    foreach: null,
    as: null,
    steps: [],
    review: null,
    refine: null,
    until: null,
    max_iterations: null,
    kind: intent.kind,
    agent: agent.agentId,
    harness: intent.harness,
  };
  STEP_SOURCE_PATHS.set(step, context.path);
  context.executableSteps.push(step);

  return step;
}

function resolveGroupStep(
  parsed: ParsedGroupStep,
  deps: RegistryDeps,
  options: WorkflowRegistryOptions,
  context: StepParseContext,
): ResolvedStep {
  const id = parsed.id;
  const foreach = parsed.foreach;
  if (foreach !== '${task.final_slices}') {
    throw new WorkflowValidationError('MVP group foreach must be ${task.final_slices}', {
      workflowId: context.workflowId,
      field: `${context.path}.foreach`,
    });
  }
  if (parsed.steps.length === 0) {
    throw new WorkflowValidationError(`group ${id}.steps must be a non-empty array`, {
      workflowId: context.workflowId,
      field: `${context.path}.steps`,
    });
  }

  const step: ResolvedStep = {
    type: 'group',
    id,
    intent: null,
    prompt_template: null,
    input_refs: {},
    vars: {},
    output_selectors: [],
    foreach,
    as: parsed.as,
    steps: parsed.steps.map((step, index) =>
      resolveExecutableStep(
        step,
        deps,
        options,
        {
          workflowId: context.workflowId,
          path: `${context.path}.steps[${String(index)}]`,
          executableSteps: context.executableSteps,
        },
      ),
    ),
    review: null,
    refine: null,
    until: null,
    max_iterations: null,
    pause_after: false,
    kind: null,
    agent: null,
    harness: null,
  };
  STEP_SOURCE_PATHS.set(step, context.path);

  return step;
}

function resolveReviewLoopStep(
  parsed: ParsedReviewLoopStep,
  deps: RegistryDeps,
  options: WorkflowRegistryOptions,
  context: StepParseContext,
): ResolvedStep {
  const id = parsed.id;
  const review = resolveExecutableStep(
    parsed.review,
    deps,
    options,
    {
      workflowId: context.workflowId,
      path: `${context.path}.review`,
      executableSteps: context.executableSteps,
    },
  );
  const refine = resolveExecutableStep(
    parsed.refine,
    deps,
    options,
    {
      workflowId: context.workflowId,
      path: `${context.path}.refine`,
      executableSteps: context.executableSteps,
    },
  );
  const until = parsed.until;
  if (until !== `\${${review.id}.passed}`) {
    throw new WorkflowValidationError(`review_loop ${id}.until must reference ${review.id}.passed`, {
      workflowId: context.workflowId,
      field: `${context.path}.until`,
    });
  }
  const maxIterations = numberGreaterThanZero(
    parsed.max_iterations,
    `review_loop ${id}.max_iterations`,
    `${context.path}.max_iterations`,
    context.workflowId,
  );
  if (review.kind !== 'review') {
    throw new WorkflowValidationError(`review_loop ${id}.review intent must be kind: review`, {
      workflowId: context.workflowId,
      field: `${context.path}.review.intent`,
    });
  }

  const step: ResolvedStep = {
    type: 'review_loop',
    id,
    intent: null,
    prompt_template: null,
    input_refs: {},
    vars: {},
    output_selectors: [],
    foreach: null,
    as: null,
    steps: [],
    review,
    refine,
    until,
    max_iterations: maxIterations,
    pause_after: false,
    kind: null,
    agent: null,
    harness: null,
  };
  STEP_SOURCE_PATHS.set(step, context.path);

  return step;
}

function validatePromptTemplate(
  promptTemplate: string,
  options: WorkflowRegistryOptions,
  field: string,
  workflowId: string,
): string {
  if (
    promptTemplate.startsWith('/') ||
    promptTemplate.includes('..') ||
    promptTemplate.trim() === ''
  ) {
    throw new WorkflowValidationError(`Unsafe prompt_template: ${promptTemplate}`, { workflowId, field });
  }
  if (options.templateExists !== undefined && !options.templateExists(promptTemplate)) {
    throw new WorkflowValidationError(`prompt_template does not exist: ${promptTemplate}`, { workflowId, field });
  }

  return promptTemplate;
}

function collectStepIds(steps: unknown[], workflowId: string): Set<string> {
  const stepIds = new Set<string>();

  const addStep = (value: unknown, field: string, sourcePath: string): void => {
    const raw = asRawStep(value, field, sourcePath, workflowId);
    const id = requiredString(raw.id, `${field}.id`, `${sourcePath}.id`, workflowId);
    if (stepIds.has(id)) {
      throw new WorkflowValidationError(`workflow ${workflowId} duplicate step id: ${id}`, {
        workflowId,
        field: `${sourcePath}.id`,
      });
    }
    stepIds.add(id);

    if (raw.type === 'group' && Array.isArray(raw.steps)) {
      raw.steps.forEach((step, index) => {
        addStep(step, `${id}.steps[${String(index)}]`, `${sourcePath}.steps[${String(index)}]`);
      });
    }
    if (raw.type === 'review_loop') {
      addStep(raw.review, `review_loop ${id}.review`, `${sourcePath}.review`);
      addStep(raw.refine, `review_loop ${id}.refine`, `${sourcePath}.refine`);
    }
  };

  steps.forEach((step, index) => {
    addStep(step, `${workflowId}.steps[${String(index)}]`, `steps[${String(index)}]`);
  });

  return stepIds;
}

function validateWorkflowReferences(workflow: ParsedWorkflow, knownStepIds: Set<string>): void {
  for (const step of workflow.steps) {
    validateStepReferences(step, workflow.id, knownStepIds, new Set());
  }
}

function validateStepReferences(
  step: ResolvedStep,
  workflowId: string,
  knownStepIds: Set<string>,
  scopedVars: Set<string>,
): void {
  if (isResolvedExecutableStep(step)) {
    validateExecutableReferences(step, workflowId, knownStepIds, scopedVars);
    return;
  }

  if (step.type === 'group') {
    const sourcePath = sourcePathFor(step);
    validateExpressionString(
      step.foreach ?? '',
      knownStepIds,
      scopedVars,
      `group ${step.id}.foreach`,
      `${sourcePath}.foreach`,
      workflowId,
    );
    const nestedScope = new Set(scopedVars);
    if (step.as !== null) {
      nestedScope.add(step.as);
    }
    for (const child of step.steps) {
      validateStepReferences(child, workflowId, knownStepIds, nestedScope);
    }
    return;
  }

  const sourcePath = sourcePathFor(step);
  validateExpressionString(
    step.until ?? '',
    knownStepIds,
    scopedVars,
    `review_loop ${step.id}.until`,
    `${sourcePath}.until`,
    workflowId,
  );
  if (step.review !== null) {
    validateExecutableReferences(step.review, workflowId, knownStepIds, scopedVars);
  }
  if (step.refine !== null) {
    validateExecutableReferences(step.refine, workflowId, knownStepIds, scopedVars);
  }
}

function validateExecutableReferences(
  step: ResolvedExecutableStep,
  workflowId: string,
  knownStepIds: Set<string>,
  scopedVars: Set<string>,
): void {
  for (const [key, value] of Object.entries(step.input_refs)) {
    validateExpressionString(
      value,
      knownStepIds,
      scopedVars,
      `step ${step.id}.input_refs.${key}`,
      `${sourcePathFor(step)}.input_refs.${key}`,
      workflowId,
    );
  }
  for (const [key, value] of Object.entries(step.vars)) {
    validateExpressionString(
      value,
      knownStepIds,
      scopedVars,
      `step ${step.id}.vars.${key}`,
      `${sourcePathFor(step)}.vars.${key}`,
      workflowId,
    );
  }
}

function validateExpressionString(
  value: string,
  knownStepIds: Set<string>,
  scopedVars: Set<string>,
  messageField: string,
  sourceField: string,
  workflowId: string,
): void {
  for (const ref of extractExpressionRefs(value)) {
    validateExpression(ref, knownStepIds, scopedVars, messageField, sourceField, workflowId);
  }
}

function sourcePathFor(step: ResolvedStep): string {
  return STEP_SOURCE_PATHS.get(step) ?? step.id;
}

function isResolvedExecutableStep(step: ResolvedStep): step is ResolvedExecutableStep {
  return step.type === 'run';
}

function validateExpression(
  expression: string,
  knownStepIds: Set<string>,
  scopedVars: Set<string>,
  messageField: string,
  sourceField: string,
  workflowId: string,
): void {
  const ref = parseValidationExpressionRef(expression, scopedVars);
  switch (ref.kind) {
    case 'empty':
      throw new WorkflowValidationError(`${messageField} has an empty expression`, { workflowId, field: sourceField });
    case 'scoped':
    case 'vars':
    case 'task':
      return;
    case 'invalid_vars':
      throw new WorkflowValidationError(`${messageField} has an invalid vars reference`, {
        workflowId,
        field: sourceField,
      });
    case 'unsupported_task_field':
      throw new WorkflowValidationError(`${messageField} has unsupported task reference field: ${ref.field}`, {
        workflowId,
        field: sourceField,
      });
    case 'step':
      if (!knownStepIds.has(ref.stepId)) {
        throw new WorkflowValidationError(`${messageField} references unknown step id: ${ref.stepId}`, {
          workflowId,
          field: sourceField,
        });
      }
      return;
    case 'unsupported_step_field':
      if (!knownStepIds.has(ref.stepId)) {
        throw new WorkflowValidationError(`${messageField} references unknown step id: ${ref.stepId}`, {
          workflowId,
          field: sourceField,
        });
      }
      throw new WorkflowValidationError(`${messageField} has unsupported step reference field: ${ref.field}`, {
        workflowId,
        field: sourceField,
      });
    case 'unsupported_reference':
      throw new WorkflowValidationError(`${messageField} has unsupported expression reference: ${ref.ref}`, {
        workflowId,
        field: sourceField,
      });
  }
}

function asRawStep(value: unknown, field: string, sourceField?: string, workflowId?: string): RawStep {
  if (!isRecord(value)) {
    if (workflowId !== undefined) {
      throw new WorkflowValidationError(`${field} must be an object`, {
        workflowId,
        field: sourceField ?? field,
      });
    }
    throw new WorkflowValidationError(`${field} must be an object`, { field: sourceField ?? field });
  }

  return value;
}

function requiredString(value: unknown, field: string, sourceField: string, workflowId: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WorkflowValidationError(`Missing required field: ${field}`, { workflowId, field: sourceField });
  }

  return value;
}

function requireOneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
  sourceField: string,
  workflowId: string,
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new WorkflowValidationError(`${field} must be one of: ${allowed.join(', ')}`, {
      workflowId,
      field: sourceField,
    });
  }

  return value;
}

function numberGreaterThanZero(value: unknown, field: string, sourceField: string, workflowId: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new WorkflowValidationError(`${field} must be a positive integer`, { workflowId, field: sourceField });
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
