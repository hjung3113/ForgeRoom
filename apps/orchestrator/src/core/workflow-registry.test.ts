import { describe, expect, it } from 'vitest';

import { AgentRegistry } from './agent-registry.js';
import { HarnessRegistry } from './harness-registry.js';
import { IntentRegistry } from './intent-registry.js';
import { WorkflowRegistry, WorkflowValidationError } from './workflow-registry.js';
import { parseWorkflowConfig } from '../dsl/workflow-parser.js';

describe('WorkflowRegistry', () => {
  const registries = makeRegistries();

  it('resolves executable steps through intent, agent, and harness registries', () => {
    const registry = WorkflowRegistry.fromConfig(
      {
        quick: {
          description: 'Quick implementation workflow',
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
            },
          ],
        },
      },
      registries,
    );

    expect(registry.get('quick')?.steps[0]).toMatchObject({
      type: 'run',
      id: 'implement',
      intent: 'codex_execute',
      prompt_template: 'execute.md',
      kind: 'execute',
      agent: 'codex',
      harness: 'implementation',
    });
  });

  it.each([
    ['direct agent override', { agent: 'codex' }],
    ['direct kind override', { kind: 'execute' }],
    ['direct harness override', { harness: 'implementation' }],
    ['inline prompt', { prompt: 'write code now' }],
  ])('rejects executable steps with %s', (_label, forbiddenFields) => {
    expect(() =>
      WorkflowRegistry.fromConfig(
        {
          quick: workflowWithStep({
            type: 'run',
            id: 'implement',
            intent: 'codex_execute',
            prompt_template: 'execute.md',
            ...forbiddenFields,
          }),
        },
        registries,
      ),
    ).toThrow(WorkflowValidationError);
  });

  it('rejects workflows missing effects metadata', () => {
    expect(() =>
      WorkflowRegistry.fromConfig(
        {
          quick: {
            description: 'Missing effects',
            steps: [
              {
                type: 'run',
                id: 'implement',
                intent: 'codex_execute',
                prompt_template: 'execute.md',
              },
            ],
          },
        },
        registries,
      ),
    ).toThrow(/effects/);
  });

  it('rejects unknown intents and unsafe prompt templates', () => {
    expect(() =>
      WorkflowRegistry.fromConfig(
        {
          quick: workflowWithStep({
            type: 'run',
            id: 'implement',
            intent: 'missing_intent',
            prompt_template: 'execute.md',
          }),
        },
        registries,
      ),
    ).toThrow(/intent/);

    expect(() =>
      WorkflowRegistry.fromConfig(
        {
          quick: workflowWithStep({
            type: 'run',
            id: 'implement',
            intent: 'codex_execute',
            prompt_template: '../outside.md',
          }),
        },
        registries,
      ),
    ).toThrow(/prompt_template/);
  });

  it('rejects invalid review loops and non-MVP foreach sources', () => {
    expect(() =>
      WorkflowRegistry.fromConfig(
        {
          full: workflowWithStep({
            type: 'review_loop',
            id: 'quality',
            until: '${other.passed}',
            max_iterations: 2,
            review: {
              id: 'review',
              intent: 'claude_review',
              prompt_template: 'review.md',
            },
            refine: {
              id: 'refine',
              intent: 'codex_execute',
              prompt_template: 'refine.md',
            },
          }),
        },
        registries,
      ),
    ).toThrow(/until/);

    expect(() =>
      WorkflowRegistry.fromConfig(
        {
          full: workflowWithStep({
            type: 'group',
            id: 'slices',
            foreach: '${plan.output.slices}',
            as: 'slice',
            steps: [
              {
                type: 'run',
                id: 'slice_impl',
                intent: 'codex_execute',
                prompt_template: 'slice_impl.md',
              },
            ],
          }),
        },
        registries,
      ),
    ).toThrow(/task.final_slices/);
  });

  it('rejects duplicate step ids and references to unknown step ids', () => {
    expect(() =>
      WorkflowRegistry.fromConfig(
        {
          full: workflowWithSteps([
            {
              type: 'run',
              id: 'implement',
              intent: 'codex_execute',
              prompt_template: 'execute.md',
            },
            {
              type: 'run',
              id: 'implement',
              intent: 'codex_execute',
              prompt_template: 'refine.md',
            },
          ]),
        },
        registries,
      ),
    ).toThrow(/duplicate step id: implement/);

    expect(() =>
      WorkflowRegistry.fromConfig(
        {
          full: workflowWithSteps([
            {
              type: 'run',
              id: 'refine',
              intent: 'codex_execute',
              prompt_template: 'refine.md',
              input_refs: {
                review: '${missing.output_path}',
              },
            },
          ]),
        },
        registries,
      ),
    ).toThrow(/unknown step id: missing/);
  });

  it('validates expression fields in input refs and vars without parsing output selectors', () => {
    const registry = WorkflowRegistry.fromConfig(
      {
        full: workflowWithSteps([
          {
            type: 'run',
            id: 'plan',
            intent: 'codex_execute',
            prompt_template: 'plan.md',
          },
          {
            type: 'run',
            id: 'implement',
            intent: 'codex_execute',
            prompt_template: 'execute.md',
            input_refs: {
              plan: '${plan.output_path}',
            },
            vars: {
              slices: '${plan.output.slices}',
            },
          },
        ]),
      },
      registries,
    );

    expect(registry.get('full')?.steps[1]?.vars).toEqual({
      slices: '${plan.output.slices}',
    });

    expect(() =>
      WorkflowRegistry.fromConfig(
        {
          full: workflowWithSteps([
            {
              type: 'run',
              id: 'plan',
              intent: 'codex_execute',
              prompt_template: 'plan.md',
            },
            {
              type: 'run',
              id: 'implement',
              intent: 'codex_execute',
              prompt_template: 'execute.md',
              vars: {
                bad: '${plan.findings}',
              },
            },
          ]),
        },
        registries,
      ),
    ).toThrow(/unsupported step reference field: findings/);
  });

  it('uses an injected prompt template existence check', () => {
    expect(() =>
      WorkflowRegistry.fromConfig(
        {
          quick: workflowWithStep({
            type: 'run',
            id: 'implement',
            intent: 'codex_execute',
            prompt_template: 'missing.md',
          }),
        },
        registries,
        { templateExists: (relativePath) => relativePath !== 'missing.md' },
      ),
    ).toThrow(/prompt_template does not exist: missing.md/);
  });

  it('disables invalid unreferenced workflows but throws for invalid referenced workflows', () => {
    const registry = WorkflowRegistry.fromConfig(
      {
        quick: workflowWithStep({
          type: 'run',
          id: 'implement',
          intent: 'codex_execute',
          prompt_template: 'execute.md',
        }),
        broken: {
          description: 'Broken library workflow',
          steps: [],
        },
      },
      registries,
      { referencedWorkflowIds: ['quick'] },
    );

    expect(registry.get('broken')).toBeNull();
    expect(registry.has('broken')).toBe(false);
    expect(registry.listDisabled()).toHaveLength(1);
    expect(registry.listDisabled()[0]?.id).toBe('broken');
    expect(registry.listDisabled()[0]?.error).toContain('effects');

    expect(() =>
      WorkflowRegistry.fromConfig(
        {
          quick: workflowWithStep({
            type: 'run',
            id: 'implement',
            intent: 'codex_execute',
            prompt_template: 'execute.md',
          }),
          broken: {
            description: 'Broken referenced workflow',
            steps: [],
          },
        },
        registries,
        { referencedWorkflowIds: ['quick', 'broken'] },
      ),
    ).toThrow(/workflow broken/);
  });

  it.each([
    {
      label: 'invalid effects.worktree',
      yaml: `quick:
  description: Invalid worktree
  effects:
    worktree: writes
    external:
      report: status
      pr: ready
  steps:
    - type: run
      id: implement
      intent: codex_execute
      prompt_template: execute.md
`,
      field: 'effects.worktree',
      location: { line: 4, column: 15 },
      message: /effects\.worktree/,
    },
    {
      label: 'missing steps[0].prompt_template',
      yaml: `quick:
  description: Missing prompt template
  effects:
    worktree: modifies
    external:
      report: status
      pr: ready
  steps:
    - type: run
      id: implement
      intent: codex_execute
`,
      field: 'steps[0].prompt_template',
      location: { line: 9, column: 7 },
      message: /prompt_template/,
    },
    {
      label: 'unsafe steps[0].prompt_template',
      yaml: `quick:
  description: Unsafe prompt template
  effects:
    worktree: modifies
    external:
      report: status
      pr: ready
  steps:
    - type: run
      id: implement
      intent: codex_execute
      prompt_template: ../outside.md
`,
      field: 'steps[0].prompt_template',
      location: { line: 12, column: 24 },
      message: /Unsafe prompt_template/,
    },
    {
      label: 'duplicate step id',
      yaml: `quick:
  description: Duplicate steps
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
    - type: run
      id: implement
      intent: codex_execute
      prompt_template: refine.md
`,
      field: 'steps[1].id',
      location: { line: 14, column: 11 },
      message: /duplicate step id: implement/,
    },
    {
      label: 'nested duplicate step id',
      yaml: `quick:
  description: Nested duplicate steps
  effects:
    worktree: modifies
    external:
      report: status
      pr: ready
  steps:
    - type: group
      id: slices
      foreach: \${task.final_slices}
      as: slice
      steps:
        - type: run
          id: implement
          intent: codex_execute
          prompt_template: execute.md
        - type: run
          id: implement
          intent: codex_execute
          prompt_template: refine.md
`,
      field: 'steps[0].steps[1].id',
      location: { line: 19, column: 15 },
      message: /duplicate step id: implement/,
    },
    {
      label: 'unknown ${missing.output_path}',
      yaml: `quick:
  description: Unknown reference
  effects:
    worktree: modifies
    external:
      report: status
      pr: ready
  steps:
    - type: run
      id: refine
      intent: codex_execute
      prompt_template: refine.md
      input_refs:
        review: \${missing.output_path}
`,
      field: 'steps[0].input_refs.review',
      location: { line: 14, column: 17 },
      message: /unknown step id: missing/,
    },
  ])('includes parser-supplied source metadata for $label', ({ yaml, field, location, message }) => {
    const parsed = parseWorkflowConfig(yaml, { source: 'configs/workflows.yaml' });

    try {
      WorkflowRegistry.fromConfig(parsed.config, registries, { sourceMap: parsed.sourceMap });
      throw new Error('Expected workflow validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowValidationError);
      const validationError = error as WorkflowValidationError;
      expect(validationError.message).toMatch(message);
      expect(validationError.sourceContext).toEqual({
        source: 'configs/workflows.yaml',
        workflowId: 'quick',
        field,
        location,
      });
    }
  });
});

function workflowWithStep(step: Record<string, unknown>) {
  return workflowWithSteps([step]);
}

function workflowWithSteps(steps: Record<string, unknown>[]) {
  return {
    description: 'Test workflow',
    effects: {
      worktree: 'modifies',
      external: { report: 'status', pr: 'ready' },
    },
    steps,
  };
}

function makeRegistries() {
  const harnessRegistry = HarnessRegistry.fromConfig({
    implementation: { source: '.forgeroom/harnesses/implementation' },
    review: { source: '.forgeroom/harnesses/review' },
  });
  const agentRegistry = AgentRegistry.fromConfig(
    {
      codex: {
        provider: 'openclaw',
        runtime: 'openai-codex',
        model: 'openai/gpt-5',
        harness: 'implementation',
      },
      claude: {
        provider: 'openclaw',
        runtime: 'claude-cli',
        model: 'anthropic/claude-opus-4-7',
        harness: 'review',
      },
    },
    harnessRegistry,
  );
  const intentRegistry = IntentRegistry.fromConfig({
    codex_execute: {
      kind: 'execute',
      agent: 'codex',
      harness: 'implementation',
    },
    claude_review: {
      kind: 'review',
      agent: 'claude',
      harness: 'review',
    },
  });

  return { intentRegistry, agentRegistry, harnessRegistry };
}
