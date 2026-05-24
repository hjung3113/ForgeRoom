import { describe, expect, it } from 'vitest';

import {
  extractExpressionRefs,
  isSupportedStepReferenceField,
  isSupportedTaskReferenceField,
  parseRuntimeExpressionRef,
  parseValidationExpressionRef,
} from './expression.js';

describe('workflow expression grammar', () => {
  it('extracts trimmed expression refs from whole and mixed strings', () => {
    expect(extractExpressionRefs('${task.title}')).toEqual(['task.title']);
    expect(extractExpressionRefs('run ${ task.branch } for ${vars.goal}')).toEqual(['task.branch', 'vars.goal']);
    expect(extractExpressionRefs('plain text')).toEqual([]);
  });

  it('shares the supported task and step reference fields', () => {
    expect(isSupportedTaskReferenceField('title')).toBe(true);
    expect(isSupportedTaskReferenceField('final_slices')).toBe(true);
    expect(isSupportedTaskReferenceField('unknown')).toBe(false);

    expect(isSupportedStepReferenceField('output')).toBe(true);
    expect(isSupportedStepReferenceField('output.slices')).toBe(true);
    expect(isSupportedStepReferenceField('findings')).toBe(false);
  });

  it('parses validation refs while preserving registry validation semantics', () => {
    const scopedVars = new Set(['slice']);

    expect(parseValidationExpressionRef('', scopedVars)).toEqual({ kind: 'empty' });
    expect(parseValidationExpressionRef('slice', scopedVars)).toEqual({ kind: 'scoped', name: 'slice' });
    expect(parseValidationExpressionRef('vars.goal', scopedVars)).toEqual({ kind: 'vars', name: 'goal' });
    expect(parseValidationExpressionRef('vars.', scopedVars)).toEqual({ kind: 'invalid_vars' });
    expect(parseValidationExpressionRef('task.branch', scopedVars)).toEqual({ kind: 'task', field: 'branch' });
    expect(parseValidationExpressionRef('task.unknown', scopedVars)).toEqual({
      kind: 'unsupported_task_field',
      field: 'unknown',
    });
    expect(parseValidationExpressionRef('plan.output.slices', scopedVars)).toEqual({
      kind: 'step',
      stepId: 'plan',
      field: 'output.slices',
    });
    expect(parseValidationExpressionRef('plan.findings', scopedVars)).toEqual({
      kind: 'unsupported_step_field',
      stepId: 'plan',
      field: 'findings',
    });
    expect(parseValidationExpressionRef('missing', scopedVars)).toEqual({
      kind: 'unsupported_reference',
      ref: 'missing',
    });
  });

  it('keeps the current runtime step-id regex narrower than validation', () => {
    expect(parseValidationExpressionRef('plan-step.output', new Set())).toEqual({
      kind: 'step',
      stepId: 'plan-step',
      field: 'output',
    });
    expect(parseRuntimeExpressionRef('plan.output')).toEqual({
      kind: 'step',
      stepId: 'plan',
      field: 'output',
    });
    expect(parseRuntimeExpressionRef('plan-step.output')).toEqual({
      kind: 'unsupported_reference',
      ref: 'plan-step.output',
    });
  });
});
