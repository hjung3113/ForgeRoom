import { describe, expect, it } from 'vitest';

import { parseForgeWorkflow, WorkflowSchemaError } from './schema.js';

describe('workflow schema parser', () => {
  it('parses a named workflow with lenient effect and selector normalization', () => {
    const parsed = parseForgeWorkflow(
      `quick:
  description: Quick workflow
  effects:
    worktree: modifies
    external: { report: status, pr: ready }
  steps:
    - type: run
      id: implement
      intent: codex_execute
      prompt_template: execute.md
      input_refs:
        issue: \${task.title}
      vars:
        count: 3
      output_selectors: [slices, ignored]
`,
      'quick',
    );

    expect(parsed).toEqual({
      id: 'quick',
      description: 'Quick workflow',
      effects: {
        worktree: 'modifies',
        external: { report: 'status', pr: 'ready' },
      },
      steps: [
        {
          type: 'run',
          id: 'implement',
          intent: 'codex_execute',
          prompt_template: 'execute.md',
          input_refs: { issue: '${task.title}' },
          vars: { count: '3' },
          output_selectors: ['slices'],
          pause_after: false,
        },
      ],
    });
  });

  it('preserves adapter leniency for defaults', () => {
    const parsed = parseForgeWorkflow(
      `quick:
  effects:
    worktree: unexpected
    external: { report: nope, pr: nope }
  steps:
    - type: run
      id: implement
      intent: codex_execute
`,
      'quick',
    );

    expect(parsed.description).toBe('');
    expect(parsed.effects).toEqual({
      worktree: 'read_only',
      external: { report: 'none', pr: 'none' },
    });
    expect(parsed.steps[0]).toMatchObject({
      type: 'run',
      prompt_template: '',
    });
  });

  it('parses group and review_loop structures', () => {
    const parsed = parseForgeWorkflow(
      `full:
  effects:
    worktree: modifies
    external: { report: final, pr: draft }
  steps:
    - type: group
      id: slices
      foreach: \${task.final_slices}
      as: slice
      steps:
        - type: run
          id: implement_slice
          intent: codex_execute
    - type: review_loop
      id: quality
      until: \${review.passed}
      max_iterations: 2
      review:
        id: review
        intent: claude_review
      refine:
        id: refine
        intent: codex_execute
`,
      'full',
    );

    expect(parsed.steps.map((step) => step.type)).toEqual(['group', 'review_loop']);
  });

  it('throws schema errors for malformed workflow structure', () => {
    expect(() => parseForgeWorkflow('quick: {}', 'missing')).toThrow(WorkflowSchemaError);
    expect(() =>
      parseForgeWorkflow(
        `quick:
  effects: {}
  steps: nope
`,
        'quick',
      ),
    ).toThrow(/workflow.steps must be a list/);
    expect(() =>
      parseForgeWorkflow(
        `quick:
  effects: {}
  steps:
    - type: nope
`,
        'quick',
      ),
    ).toThrow(/unknown step type/);
  });
});
