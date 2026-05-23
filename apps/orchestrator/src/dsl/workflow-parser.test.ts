import { describe, expect, it } from 'vitest';

import { WorkflowParseError } from './dsl-errors.js';
import { parseWorkflowConfig, workflowSourceContext } from './workflow-parser.js';

describe('parseWorkflowConfig', () => {
  it('parses workflow yaml text into raw config objects and preserves source locations', () => {
    const parsed = parseWorkflowConfig(`quick:
  description: Quick implementation workflow
  effects:
    worktree: modifies
    external:
      report: status
      pr: ready
  steps:
    - type: run
      id: implement
      intent: codex_execute
      prompt_template: execute.md
`);

    expect(parsed.config).toEqual({
      quick: {
        description: 'Quick implementation workflow',
        effects: {
          worktree: 'modifies',
          external: {
            report: 'status',
            pr: 'ready',
          },
        },
        steps: [
          {
            type: 'run',
            id: 'implement',
            intent: 'codex_execute',
            prompt_template: 'execute.md',
          },
        ],
      },
    });
    expect(parsed.sourceMap.workflows.quick?.id).toEqual({ line: 1, column: 1 });
    expect(parsed.sourceMap.workflows.quick?.fields['effects.worktree']).toEqual({
      line: 4,
      column: 15,
    });
    expect(parsed.sourceMap.workflows.quick?.fields['steps[0].prompt_template']).toEqual({
      line: 12,
      column: 24,
    });
  });

  it('throws a parse error with yaml line information for malformed yaml', () => {
    const parseBrokenWorkflow = () =>
      parseWorkflowConfig(
        `quick:
  description: Broken workflow
  effects:
    worktree: modifies
    external:
      report: status
      pr: ready
  steps:
    - type: run
      id: implement
      intent: codex_execute
      prompt_template: [broken
`,
        { source: 'configs/workflows.yaml' },
      );

    expect(() =>
      parseWorkflowConfig(`quick:
  description: Broken workflow
  effects:
    worktree: modifies
    external:
      report: status
      pr: ready
  steps:
    - type: run
      id: implement
      intent: codex_execute
      prompt_template: [broken
`),
    ).toThrow(WorkflowParseError);

    expect(parseBrokenWorkflow).toThrow(/line 13/);
    try {
      parseBrokenWorkflow();
      throw new Error('Expected parseBrokenWorkflow to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowParseError);
      const parseError = error as WorkflowParseError;
      expect(parseError.source).toBe('configs/workflows.yaml');
      expect(parseError.location).toEqual({ line: 13, column: 1 });
    }
  });

  it('provides source, workflow id, and field context for missing field diagnostics', () => {
    const parsed = parseWorkflowConfig(
      `quick:
  effects:
    worktree: modifies
    external:
      report: status
      pr: ready
  steps:
    - type: run
      id: implement
      intent: codex_execute
      prompt_template: execute.md
`,
      { source: 'configs/workflows.yaml' },
    );

    expect(workflowSourceContext(parsed.sourceMap, 'quick', 'description')).toEqual({
      source: 'configs/workflows.yaml',
      workflowId: 'quick',
      field: 'description',
      location: { line: 1, column: 1 },
    });
  });
});
