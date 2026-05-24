export const TASK_REFERENCE_FIELDS = new Set([
  'title',
  'description',
  'project',
  'branch',
  'worktree_path',
  'issue_number',
  'full_diff_path',
  'final_slices',
]);

export const STEP_REFERENCE_FIELDS = new Set(['output', 'output.slices', 'output_path', 'diff_path', 'passed']);

const EXPRESSION_REF_RE = /\$\{([^}]+)\}/g;
const WHOLE_EXPRESSION_RE = /^\$\{([^}]+)\}$/;
const RUNTIME_STEP_REFERENCE_RE = /^(\w+)\.(output\.slices|output_path|output|diff_path|passed)$/;

export type ValidationExpressionRef =
  | { kind: 'empty' }
  | { kind: 'scoped'; name: string }
  | { kind: 'vars'; name: string }
  | { kind: 'invalid_vars' }
  | { kind: 'task'; field: string }
  | { kind: 'unsupported_task_field'; field: string }
  | { kind: 'step'; stepId: string; field: string }
  | { kind: 'unsupported_step_field'; stepId: string; field: string }
  | { kind: 'unsupported_reference'; ref: string };

export type RuntimeExpressionRef =
  | { kind: 'scoped'; name: string }
  | { kind: 'vars'; name: string }
  | { kind: 'task'; field: string }
  | { kind: 'step'; stepId: string; field: string }
  | { kind: 'unsupported_reference'; ref: string };

export function extractExpressionRefs(value: string): string[] {
  return [...value.matchAll(EXPRESSION_REF_RE)].map((match) => (match[1] ?? '').trim());
}

export function wholeExpressionRef(value: string): string | null {
  const match = WHOLE_EXPRESSION_RE.exec(value.trim());
  return match === null ? null : (match[1] ?? '');
}

export function replaceExpressionRefs(
  value: string,
  replace: (ref: string) => string,
): string {
  return value.replace(EXPRESSION_REF_RE, (_match, ref: string) => replace(ref.trim()));
}

export function isSupportedTaskReferenceField(field: string): boolean {
  return TASK_REFERENCE_FIELDS.has(field);
}

export function isSupportedStepReferenceField(field: string): boolean {
  return STEP_REFERENCE_FIELDS.has(field);
}

export function parseValidationExpressionRef(
  expression: string,
  scopedVars: Set<string>,
): ValidationExpressionRef {
  if (expression === '') {
    return { kind: 'empty' };
  }
  if (scopedVars.has(expression)) {
    return { kind: 'scoped', name: expression };
  }
  if (expression.startsWith('vars.')) {
    if (expression === 'vars.') {
      return { kind: 'invalid_vars' };
    }
    return { kind: 'vars', name: expression.slice('vars.'.length) };
  }
  if (expression.startsWith('task.')) {
    const field = expression.slice('task.'.length);
    if (!isSupportedTaskReferenceField(field)) {
      return { kind: 'unsupported_task_field', field };
    }
    return { kind: 'task', field };
  }

  const fieldStart = expression.indexOf('.');
  if (fieldStart === -1) {
    return { kind: 'unsupported_reference', ref: expression };
  }

  const stepId = expression.slice(0, fieldStart);
  const field = expression.slice(fieldStart + 1);
  if (!isSupportedStepReferenceField(field)) {
    return { kind: 'unsupported_step_field', stepId, field };
  }
  return { kind: 'step', stepId, field };
}

export function parseRuntimeExpressionRef(
  ref: string,
  scopedVars: Set<string> = new Set(),
): RuntimeExpressionRef {
  if (scopedVars.has(ref)) {
    return { kind: 'scoped', name: ref };
  }
  if (ref.startsWith('vars.')) {
    return { kind: 'vars', name: ref.slice('vars.'.length) };
  }
  if (ref.startsWith('task.')) {
    const field = ref.slice('task.'.length);
    if (isSupportedTaskReferenceField(field)) {
      return { kind: 'task', field };
    }
    return { kind: 'unsupported_reference', ref };
  }

  const stepMatch = RUNTIME_STEP_REFERENCE_RE.exec(ref);
  if (stepMatch) {
    return {
      kind: 'step',
      stepId: stepMatch[1] as string,
      field: stepMatch[2] as string,
    };
  }

  return { kind: 'unsupported_reference', ref };
}
