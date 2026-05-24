import { isMap, parseDocument } from 'yaml';

import type {
  ParsedExecutableSpec,
  ParsedForgeWorkflow,
  ParsedRunStep,
  ParsedStep,
  SelectorName,
  WorkflowEffects,
} from './types.js';

export class WorkflowSchemaError extends Error {
  constructor(
    message: string,
    readonly workflowId: string,
    readonly field: string | null = null,
  ) {
    super(field === null ? message : `${message} (${workflowId}.${field})`);
    this.name = 'WorkflowSchemaError';
  }
}

export class WorkflowSourceParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowSourceParseError';
  }
}

export function parseForgeWorkflow(source: string, workflowId: string): ParsedForgeWorkflow {
  const document = parseDocument(source, {
    keepSourceTokens: true,
    prettyErrors: false,
  });
  const firstError = document.errors[0];
  if (firstError !== undefined) {
    throw new WorkflowSourceParseError('Failed to parse workflow yaml');
  }
  if (!isMap(document.contents)) {
    throw new WorkflowSourceParseError('Workflow yaml must be a top-level mapping');
  }

  const config = document.toJS() as Record<string, Record<string, unknown>>;
  const raw = config[workflowId];
  if (raw === undefined) {
    throw new WorkflowSchemaError('workflow not found in source', workflowId);
  }
  return normalizeWorkflow(workflowId, raw);
}

export function normalizeWorkflow(id: string, raw: Record<string, unknown>): ParsedForgeWorkflow {
  const effects = normalizeEffects(id, raw.effects);
  const rawSteps = raw.steps;
  if (!Array.isArray(rawSteps)) {
    throw new WorkflowSchemaError('workflow.steps must be a list', id, 'steps');
  }
  const steps = rawSteps.map((s, i) => normalizeStep(id, s, `steps[${String(i)}]`));
  return {
    id,
    description: typeof raw.description === 'string' ? raw.description : '',
    effects,
    steps,
  };
}

export function normalizeEffects(id: string, raw: unknown): WorkflowEffects {
  if (!isRecord(raw)) {
    throw new WorkflowSchemaError('workflow.effects must be a mapping', id, 'effects');
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

export function normalizeStep(workflowId: string, raw: unknown, field: string): ParsedStep {
  if (!isRecord(raw)) {
    throw new WorkflowSchemaError('step must be a mapping', workflowId, field);
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
            throw new WorkflowSchemaError('group.steps must be a list', workflowId, `${field}.steps`);
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
  throw new WorkflowSchemaError(`unknown step type: ${String(type)}`, workflowId, `${field}.type`);
}

export function normalizeRunStep(workflowId: string, raw: unknown, field: string): ParsedRunStep {
  if (!isRecord(raw) || raw.type !== 'run') {
    throw new WorkflowSchemaError('expected a `type: run` step', workflowId, field);
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

export function normalizeExecutableSpec(
  workflowId: string,
  raw: unknown,
  field: string,
): ParsedExecutableSpec {
  if (!isRecord(raw)) {
    throw new WorkflowSchemaError('expected an executable spec mapping', workflowId, field);
  }
  return {
    id: requireStringField(workflowId, raw.id, `${field}.id`),
    intent: requireStringField(workflowId, raw.intent, `${field}.intent`),
    prompt_template: typeof raw.prompt_template === 'string' ? raw.prompt_template : '',
    input_refs: normalizeStringMap(raw.input_refs),
    vars: normalizeStringMap(raw.vars),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function requireStringField(workflowId: string, value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WorkflowSchemaError('missing required field', workflowId, field);
  }
  return value;
}

function requireNumberField(workflowId: string, value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new WorkflowSchemaError('missing required numeric field', workflowId, field);
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
