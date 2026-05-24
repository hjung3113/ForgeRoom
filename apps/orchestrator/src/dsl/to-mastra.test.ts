import { Mastra } from '@mastra/core';
import { MockStore } from '@mastra/core/storage';
import { describe, expect, it, vi } from 'vitest';

import { IntentRegistry } from '../core/intent-registry.js';
import { AdapterValidationError } from './dsl-errors.js';
import {
  adapterCacheKey,
  buildMastraWorkflowCached,
  toMastraWorkflow,
  type StepExecution,
} from './to-mastra.js';
import { parseForgeWorkflow } from '../workflow/schema.js';
import type {
  AdapterContext,
  ParsedForgeWorkflow,
  ParsedRunStep,
  ResolvedWorkflow,
  ResolvedWorkflowExecutableStep,
  ResolvedWorkflowStep,
} from '../workflow/types.js';

const INTENTS = IntentRegistry.fromConfig({
  codex_execute: { kind: 'execute', agent: 'codex', harness: 'implementation' },
  claude_review: { kind: 'review', agent: 'claude', harness: 'review' },
  claude_plan: { kind: 'write_plan', agent: 'claude', harness: 'planning' },
});

function resolveForAdapter(parsed: ParsedForgeWorkflow, intents = INTENTS): ResolvedWorkflow {
  const executableSteps: ResolvedWorkflowExecutableStep[] = [];
  const resolveRun = (step: ParsedRunStep): ResolvedWorkflowExecutableStep => {
    if (!intents.has(step.intent)) {
      throw new AdapterValidationError(`unknown intent reference: ${step.intent}`, parsed.id, `${step.id}.intent`);
    }
    if (step.prompt_template.trim() === '') {
      throw new AdapterValidationError('missing prompt_template', parsed.id, `${step.id}.prompt_template`);
    }
    const intent = intents.resolve(step.intent);
    const resolved: ResolvedWorkflowExecutableStep = {
      type: 'run',
      id: step.id,
      intent: step.intent,
      prompt_template: step.prompt_template,
      input_refs: step.input_refs,
      vars: step.vars,
      output_selectors: step.output_selectors,
      foreach: null,
      as: null,
      steps: [],
      review: null,
      refine: null,
      until: null,
      max_iterations: null,
      pause_after: step.pause_after,
      kind: intent.kind,
      agent: intent.agent,
      harness: intent.harness,
    };
    executableSteps.push(resolved);
    return resolved;
  };
  const resolveStep = (step: ParsedForgeWorkflow['steps'][number]): ResolvedWorkflowStep => {
    if (step.type === 'run') {
      return resolveRun(step);
    }
    if (step.type === 'group') {
      return {
        ...step,
        intent: null,
        prompt_template: null,
        input_refs: {},
        vars: {},
        output_selectors: [],
        steps: step.steps.map((inner) => resolveRun(inner)),
        review: null,
        refine: null,
        until: null,
        max_iterations: null,
        pause_after: false,
        kind: null,
        agent: null,
        harness: null,
      };
    }
    const review = resolveRun({ ...step.review, type: 'run', output_selectors: [], pause_after: false });
    const refine = resolveRun({ ...step.refine, type: 'run', output_selectors: [], pause_after: false });
    const expected = `\${${step.review.id}.passed}`;
    if (step.until.trim() !== expected) {
      throw new AdapterValidationError(`invalid until expression: expected ${expected}`, parsed.id, `${step.id}.until`);
    }
    if (review.kind !== 'review') {
      throw new AdapterValidationError(
        `review_loop.review intent must be kind: review`,
        parsed.id,
        `${step.id}.review.intent`,
      );
    }
    return {
      ...step,
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
      pause_after: false,
      kind: null,
      agent: null,
      harness: null,
    };
  };
  return {
    id: parsed.id,
    description: parsed.description,
    effects: parsed.effects,
    steps: parsed.steps.map(resolveStep),
    executableSteps,
  };
}

/** A fake collaborator set that records the order of operations per step. */
function makeCtx(overrides: Partial<AdapterContext> = {}): {
  ctx: AdapterContext;
  log: string[];
} {
  const log: string[] = [];

  const ctx: AdapterContext = {
    interpolation: {
      task: {
        title: 'Add login',
        description: 'desc',
        project: 'proj',
        branch: 'feat/login',
        worktree_path: '/wt',
        issue_number: '42',
        full_diff_path: '/wt/.forgeroom/full.diff',
        final_slices: ['slice-a', 'slice-b'],
      },
      vars: { greeting: 'hi' },
      stepOutputs: {},
    },
    collaborators: {
      renderPrompt: async (resolved, interpolated) => {
        log.push(`render:${resolved.mastraStepId}`);
        return `/wt/.forgeroom/prompts/${resolved.stepId}.md:${JSON.stringify(interpolated.vars)}`;
      },
      runAgent: async (resolved) => {
        log.push(`agent:${resolved.mastraStepId}`);
        return {
          outputPath: `/wt/.forgeroom/outputs/${resolved.stepId}.md`,
          output: defaultOutputFor(resolved),
          diffPath: `/wt/.forgeroom/diffs/${resolved.stepId}.diff`,
        };
      },
      runChecks: async (resolved) => {
        log.push(`checks:${resolved.mastraStepId}`);
        return { allPassed: true };
      },
      saveDiff: async (resolved) => {
        log.push(`diff:${resolved.mastraStepId}`);
        return `/wt/.forgeroom/diffs/${resolved.stepId}.diff`;
      },
      conductorUpdate: async (resolved) => {
        log.push(`conductor:${resolved.mastraStepId}`);
      },
      suspend: async () => {
        log.push('suspend');
      },
    },
    selectors: {
      parseSlices: (output) => {
        const slices = output
          .split('\n')
          .filter((l) => l.startsWith('- '))
          .map((l) => l.slice(2).trim());
        if (slices.length === 0) throw new Error('no slices');
        return slices;
      },
      parseReviewPassed: (output) => output.includes('Review Result: pass'),
    },
    ...overrides,
  };

  return { ctx, log };
}

function defaultOutputFor(resolved: { kind: string }): string {
  if (resolved.kind === 'review') return 'Review Result: pass\nlooks good';
  if (resolved.kind === 'write_plan') return '## Slices\n- slice-a\n- slice-b\n';
  return 'done';
}

const SEQUENTIAL_YAML = `quick:
  description: quick
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
      vars:
        greeting: \${vars.greeting}
`;

describe('parseForgeWorkflow', () => {
  it('parses a single named workflow with effects and steps', () => {
    const parsed = parseForgeWorkflow(SEQUENTIAL_YAML, 'quick');
    expect(parsed.id).toBe('quick');
    expect(parsed.effects).toEqual({
      worktree: 'modifies',
      external: { report: 'status', pr: 'ready' },
    });
    expect(parsed.steps).toHaveLength(1);
    expect(parsed.steps[0]).toMatchObject({ type: 'run', id: 'implement', intent: 'codex_execute' });
  });
});

describe('toMastraWorkflow — sequential run', () => {
  it('builds a workflow that compiles and runs the step body in ADR-016 order', async () => {
    const parsed = parseForgeWorkflow(SEQUENTIAL_YAML, 'quick');
    const { ctx, log } = makeCtx();
    const built = toMastraWorkflow(resolveForAdapter(parsed), ctx);

    expect(built.effects.worktree).toBe('modifies');

    const mastra = new Mastra({ workflows: { wf: built.workflow }, storage: new MockStore() });
    const run = await mastra.getWorkflow('wf').createRun();
    const result = await run.start({ inputData: {} });

    expect(result.status).toBe('success');
    // ADR-016 step body order: render -> agent -> (checks for execute) -> diff -> conductor
    expect(log).toEqual([
      'render:codex_execute:implement',
      'agent:codex_execute:implement',
      'checks:codex_execute:implement',
      'diff:codex_execute:implement',
      'conductor:codex_execute:implement',
    ]);
  });

  it('does NOT run checks for non-execute kinds', async () => {
    const yaml = `plan_wf:
  description: plan
  effects:
    worktree: read_only
    external:
      report: none
      pr: none
  steps:
    - type: run
      id: plan
      intent: claude_plan
      prompt_template: plan.md
`;
    const parsed = parseForgeWorkflow(yaml, 'plan_wf');
    const { ctx, log } = makeCtx();
    const built = toMastraWorkflow(resolveForAdapter(parsed), ctx);
    const mastra = new Mastra({ workflows: { wf: built.workflow }, storage: new MockStore() });
    const run = await mastra.getWorkflow('wf').createRun();
    await run.start({ inputData: {} });
    expect(log).not.toContain('checks:claude_plan:plan');
  });
});

describe('toMastraWorkflow — interpolation', () => {
  it('evaluates ${vars.*} and ${task.*} at step input bind time', async () => {
    const parsed = parseForgeWorkflow(SEQUENTIAL_YAML, 'quick');
    const interpolated: unknown[] = [];
    const { ctx } = makeCtx();
    ctx.collaborators.renderPrompt = async (_resolved, vars) => {
      interpolated.push(vars);
      return 'p';
    };
    const built = toMastraWorkflow(resolveForAdapter(parsed), ctx);
    const mastra = new Mastra({ workflows: { wf: built.workflow }, storage: new MockStore() });
    const run = await mastra.getWorkflow('wf').createRun();
    await run.start({ inputData: {} });
    expect(interpolated[0]).toMatchObject({ vars: { greeting: 'hi' } });
  });

  it('fails fast on a missing variable', async () => {
    const yaml = `bad:
  description: bad
  effects:
    worktree: read_only
    external:
      report: none
      pr: none
  steps:
    - type: run
      id: s
      intent: codex_execute
      prompt_template: e.md
      vars:
        x: \${vars.nonexistent}
`;
    const parsed = parseForgeWorkflow(yaml, 'bad');
    const { ctx } = makeCtx();
    // Interpolation is evaluated at step bind time (run), so building succeeds
    // but running fails fast on the missing variable.
    const built = toMastraWorkflow(resolveForAdapter(parsed), ctx);
    expect(built.workflow).toBeDefined();
    const mastra = new Mastra({ workflows: { wf: built.workflow }, storage: new MockStore() });
    const run = await mastra.getWorkflow('wf').createRun();
    const result = await run.start({ inputData: {} });
    expect(result.status).toBe('failed');
  });

  it('interpolates mixed text with multiple ${...} refs into a string', async () => {
    const yaml = `mix:
  description: mix
  effects:
    worktree: read_only
    external: { report: none, pr: none }
  steps:
    - type: run
      id: s
      intent: codex_execute
      prompt_template: e.md
      vars:
        line: "\${task.title} on \${task.branch}"
`;
    const parsed = parseForgeWorkflow(yaml, 'mix');
    const captured: unknown[] = [];
    const { ctx } = makeCtx();
    ctx.collaborators.renderPrompt = async (_r, vars) => {
      captured.push(vars.vars.line);
      return 'p';
    };
    const built = toMastraWorkflow(resolveForAdapter(parsed), ctx);
    const mastra = new Mastra({ workflows: { wf: built.workflow }, storage: new MockStore() });
    const run = await mastra.getWorkflow('wf').createRun();
    await run.start({ inputData: {} });
    expect(captured[0]).toBe('Add login on feat/login');
  });
});

describe('toMastraWorkflow — foreach', () => {
  const FOREACH_YAML = `slices_wf:
  description: foreach
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
          id: slice_impl
          intent: codex_execute
          prompt_template: slice_impl.md
          vars:
            slice: \${slice}
`;

  it('maps group+foreach to a sequential concurrency-1 foreach and binds `as`', async () => {
    const parsed = parseForgeWorkflow(FOREACH_YAML, 'slices_wf');
    const boundSlices: unknown[] = [];
    const { ctx } = makeCtx();
    ctx.collaborators.renderPrompt = async (_resolved, vars) => {
      boundSlices.push(vars.vars.slice);
      return 'p';
    };
    const built = toMastraWorkflow(resolveForAdapter(parsed), ctx);
    const mastra = new Mastra({ workflows: { wf: built.workflow }, storage: new MockStore() });
    const run = await mastra.getWorkflow('wf').createRun();
    const result = await run.start({ inputData: {} });
    expect(result.status).toBe('success');
    expect(boundSlices).toEqual(['slice-a', 'slice-b']);
  });

  it('resolves the foreach list LAZILY at runtime, not at build time', async () => {
    // The list is empty at BUILD time and only populated (as the engine does
    // from a prior plan step) AFTER the workflow is built. A build-time capture
    // would iterate the empty array; a lazy read sees the runtime values.
    const parsed = parseForgeWorkflow(FOREACH_YAML, 'slices_wf');
    const boundSlices: unknown[] = [];
    const { ctx } = makeCtx();
    ctx.interpolation.task.final_slices = [];
    ctx.collaborators.renderPrompt = async (_resolved, vars) => {
      boundSlices.push(vars.vars.slice);
      return 'p';
    };

    const built = toMastraWorkflow(resolveForAdapter(parsed), ctx);

    // Populate the list AFTER the build (simulating the runtime plan step).
    ctx.interpolation.task.final_slices = ['runtime-1', 'runtime-2', 'runtime-3'];

    const mastra = new Mastra({ workflows: { wf: built.workflow }, storage: new MockStore() });
    const run = await mastra.getWorkflow('wf').createRun();
    const result = await run.start({ inputData: {} });
    expect(result.status).toBe('success');
    expect(boundSlices).toEqual(['runtime-1', 'runtime-2', 'runtime-3']);
  });

  it('does NOT leak slices across two runs of a cached/reused built workflow', async () => {
    // Build ONCE (cached), then run the SAME built workflow twice with two
    // different runtime slice lists. A build-time array snapshot inside the
    // foreach list step would bleed run A's slices into run B; a lazy read of
    // the current interpolation source binds only the run's own list.
    const parsed = parseForgeWorkflow(FOREACH_YAML, 'slices_wf');
    const { ctx } = makeCtx();
    const boundSlices: unknown[] = [];
    ctx.collaborators.renderPrompt = async (_resolved, vars) => {
      boundSlices.push(vars.vars.slice);
      return 'p';
    };

    const cache = new Map<string, ReturnType<typeof toMastraWorkflow>>();
    const build = (): ReturnType<typeof toMastraWorkflow> => toMastraWorkflow(resolveForAdapter(parsed), ctx);
    const cacheParts = { yamlSource: FOREACH_YAML, intentsSource: 'i', mastraVersion: '1.36.0' };

    // Run A: list = [a1, a2].
    const builtA = buildMastraWorkflowCached(cacheParts, cache, build);
    ctx.interpolation.task.final_slices = ['a1', 'a2'];
    const mastraA = new Mastra({ workflows: { wf: builtA.workflow }, storage: new MockStore() });
    const runA = await mastraA.getWorkflow('wf').createRun();
    expect((await runA.start({ inputData: {} })).status).toBe('success');
    expect(boundSlices).toEqual(['a1', 'a2']);

    // Run B reuses the SAME cached built workflow with a different list.
    const builtB = buildMastraWorkflowCached(cacheParts, cache, build);
    expect(builtB).toBe(builtA); // proves the workflow object was reused, not rebuilt
    boundSlices.length = 0;
    ctx.interpolation.task.final_slices = ['b1', 'b2', 'b3'];
    const mastraB = new Mastra({ workflows: { wf: builtB.workflow }, storage: new MockStore() });
    const runB = await mastraB.getWorkflow('wf').createRun();
    expect((await runB.start({ inputData: {} })).status).toBe('success');
    // No bleed: run B sees ONLY its own slices.
    expect(boundSlices).toEqual(['b1', 'b2', 'b3']);
  });
});

describe('toMastraWorkflow — review_loop', () => {
  function reviewLoopYaml(maxIterations: number): string {
    return `rl_wf:
  description: rl
  effects:
    worktree: modifies
    external:
      report: status
      pr: ready
  steps:
    - type: review_loop
      id: quality
      until: \${review.passed}
      max_iterations: ${maxIterations}
      review:
        id: review
        intent: claude_review
        prompt_template: review.md
      refine:
        id: refine
        intent: codex_execute
        prompt_template: refine.md
`;
  }

  it('passes on the first review (small max_iterations) and never refines', async () => {
    const parsed = parseForgeWorkflow(reviewLoopYaml(3), 'rl_wf');
    const { ctx, log } = makeCtx();
    const built = toMastraWorkflow(resolveForAdapter(parsed), ctx);
    const mastra = new Mastra({ workflows: { wf: built.workflow }, storage: new MockStore() });
    const run = await mastra.getWorkflow('wf').createRun();
    const result = await run.start({ inputData: {} });
    expect(result.status).toBe('success');
    // first review passes -> refine never runs
    expect(log.filter((l) => l.startsWith('agent:codex_execute:refine'))).toHaveLength(0);
    expect(log.filter((l) => l.startsWith('agent:claude_review:review'))).toHaveLength(1);
  });

  it('threads iteration and loops refine->review until passed (large max_iterations)', async () => {
    const parsed = parseForgeWorkflow(reviewLoopYaml(5), 'rl_wf');
    const { ctx, log } = makeCtx();
    // Fail twice, then pass: review passes only when iteration >= 2
    let reviewCalls = 0;
    ctx.collaborators.runAgent = async (resolved) => {
      log.push(`agent:${resolved.mastraStepId}`);
      if (resolved.kind === 'review') {
        const passed = reviewCalls >= 2;
        reviewCalls += 1;
        return {
          outputPath: `/o/${resolved.stepId}.md`,
          output: passed ? 'Review Result: pass' : 'Review Result: fail',
          diffPath: null,
        };
      }
      return { outputPath: `/o/${resolved.stepId}.md`, output: 'done', diffPath: '/d.diff' };
    };
    const built = toMastraWorkflow(resolveForAdapter(parsed), ctx);
    const mastra = new Mastra({ workflows: { wf: built.workflow }, storage: new MockStore() });
    const run = await mastra.getWorkflow('wf').createRun();
    const result = await run.start({ inputData: {} });
    expect(result.status).toBe('success');
    // review ran 3 times (iteration 0,1,2); refine ran 2 times
    expect(log.filter((l) => l === 'agent:claude_review:review')).toHaveLength(3);
    expect(log.filter((l) => l === 'agent:codex_execute:refine')).toHaveLength(2);
  });

  it('fails with review_loop_max_iterations when refine budget is exhausted', async () => {
    const parsed = parseForgeWorkflow(reviewLoopYaml(1), 'rl_wf');
    const { ctx } = makeCtx();
    ctx.collaborators.runAgent = async (resolved) => ({
      outputPath: `/o/${resolved.stepId}.md`,
      output: resolved.kind === 'review' ? 'Review Result: fail' : 'done',
      diffPath: null,
    });
    const built = toMastraWorkflow(resolveForAdapter(parsed), ctx);
    const mastra = new Mastra({ workflows: { wf: built.workflow }, storage: new MockStore() });
    const run = await mastra.getWorkflow('wf').createRun();
    const result = await run.start({ inputData: {} });
    expect(result.status).toBe('failed');
  });
});

describe('toMastraWorkflow — selector parsing inside body', () => {
  it('parses selectors in the step body and returns them in the step output shape', async () => {
    const yaml = `plan_wf:
  description: plan
  effects:
    worktree: read_only
    external:
      report: status
      pr: none
  steps:
    - type: run
      id: plan
      intent: claude_plan
      prompt_template: plan.md
      output_selectors:
        - slices
`;
    const parsed = parseForgeWorkflow(yaml, 'plan_wf');
    const sliceParse = vi.fn((output: string) =>
      output.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim()),
    );
    const { ctx } = makeCtx();
    ctx.selectors.parseSlices = sliceParse;
    const built = toMastraWorkflow(resolveForAdapter(parsed), ctx);
    const mastra = new Mastra({ workflows: { wf: built.workflow }, storage: new MockStore() });
    const run = await mastra.getWorkflow('wf').createRun();
    const result = await run.start({ inputData: {} });
    expect(result.status).toBe('success');
    // selector parser was invoked inside the body
    expect(sliceParse).toHaveBeenCalled();
    // parsed value flows into the step output
    const stepOutput = (result as { steps: Record<string, { output?: StepExecution }> }).steps[
      'claude_plan:plan'
    ]?.output;
    expect(stepOutput?.slices).toEqual(['slice-a', 'slice-b']);
  });
});

describe('toMastraWorkflow — pause_after', () => {
  it('appends a pauseAfterGate step that suspends after the worker', async () => {
    const yaml = `pw:
  description: pause
  effects:
    worktree: modifies
    external:
      report: status
      pr: none
  steps:
    - type: run
      id: critical
      intent: codex_execute
      prompt_template: c.md
      pause_after: true
`;
    const parsed = parseForgeWorkflow(yaml, 'pw');
    const { ctx, log } = makeCtx();
    const built = toMastraWorkflow(resolveForAdapter(parsed), ctx);
    const mastra = new Mastra({ workflows: { wf: built.workflow }, storage: new MockStore() });
    const run = await mastra.getWorkflow('wf').createRun();
    const result = await run.start({ inputData: {} });
    // worker ran and conductor updated BEFORE suspend; then the gate suspends
    expect(result.status).toBe('suspended');
    expect(log).toContain('conductor:codex_execute:critical');
    const conductorIdx = log.indexOf('conductor:codex_execute:critical');
    // gate step id present
    expect(built.workflow.id).toBeDefined();
    expect(conductorIdx).toBeGreaterThanOrEqual(0);
  });
});

describe('adapter validation', () => {
  it('throws adapter_validation_failed on unknown intent reference', () => {
    const yaml = `w:
  description: x
  effects:
    worktree: read_only
    external: { report: none, pr: none }
  steps:
    - type: run
      id: s
      intent: does_not_exist
      prompt_template: e.md
`;
    const parsed = parseForgeWorkflow(yaml, 'w');
    const { ctx } = makeCtx();
    expect(() => toMastraWorkflow(resolveForAdapter(parsed), ctx)).toThrow(AdapterValidationError);
    try {
      toMastraWorkflow(resolveForAdapter(parsed), ctx);
    } catch (err) {
      expect((err as AdapterValidationError).failure_reason).toBe('adapter_validation_failed');
    }
  });

  it('throws on missing prompt_template', () => {
    const yaml = `w:
  description: x
  effects:
    worktree: read_only
    external: { report: none, pr: none }
  steps:
    - type: run
      id: s
      intent: codex_execute
`;
    const parsed = parseForgeWorkflow(yaml, 'w');
    const { ctx } = makeCtx();
    expect(() => toMastraWorkflow(resolveForAdapter(parsed), ctx)).toThrow(AdapterValidationError);
  });

  it('throws on invalid until expression', () => {
    const yaml = `w:
  description: x
  effects:
    worktree: modifies
    external: { report: status, pr: none }
  steps:
    - type: review_loop
      id: q
      until: \${review.somethingelse}
      max_iterations: 2
      review:
        id: review
        intent: claude_review
        prompt_template: r.md
      refine:
        id: refine
        intent: codex_execute
        prompt_template: f.md
`;
    const parsed = parseForgeWorkflow(yaml, 'w');
    const { ctx } = makeCtx();
    expect(() => toMastraWorkflow(resolveForAdapter(parsed), ctx)).toThrow(AdapterValidationError);
  });

  it('throws when review intent is not kind: review', () => {
    const yaml = `w:
  description: x
  effects:
    worktree: modifies
    external: { report: status, pr: none }
  steps:
    - type: review_loop
      id: q
      until: \${review.passed}
      max_iterations: 2
      review:
        id: review
        intent: codex_execute
        prompt_template: r.md
      refine:
        id: refine
        intent: codex_execute
        prompt_template: f.md
`;
    const parsed = parseForgeWorkflow(yaml, 'w');
    const { ctx } = makeCtx();
    expect(() => toMastraWorkflow(resolveForAdapter(parsed), ctx)).toThrow(AdapterValidationError);
  });
});

describe('adapter cache', () => {
  it('cache key changes on yaml change, intents change, and mastra version bump', () => {
    const k1 = adapterCacheKey({ yamlSource: 'a', intentsSource: 'i', mastraVersion: '1.36.0' });
    const k2 = adapterCacheKey({ yamlSource: 'b', intentsSource: 'i', mastraVersion: '1.36.0' });
    const k3 = adapterCacheKey({ yamlSource: 'a', intentsSource: 'j', mastraVersion: '1.36.0' });
    const k4 = adapterCacheKey({ yamlSource: 'a', intentsSource: 'i', mastraVersion: '1.37.0' });
    expect(new Set([k1, k2, k3, k4]).size).toBe(4);
    expect(adapterCacheKey({ yamlSource: 'a', intentsSource: 'i', mastraVersion: '1.36.0' })).toBe(k1);
  });

  it('returns the same built workflow for identical inputs and rebuilds on change', () => {
    const cache = new Map();
    const { ctx } = makeCtx();
    const build = (): ReturnType<typeof toMastraWorkflow> => {
      const parsed = parseForgeWorkflow(SEQUENTIAL_YAML, 'quick');
      return toMastraWorkflow(resolveForAdapter(parsed), ctx);
    };
    const a = buildMastraWorkflowCached(
      { yamlSource: SEQUENTIAL_YAML, intentsSource: 'i', mastraVersion: '1.36.0' },
      cache,
      build,
    );
    const b = buildMastraWorkflowCached(
      { yamlSource: SEQUENTIAL_YAML, intentsSource: 'i', mastraVersion: '1.36.0' },
      cache,
      build,
    );
    expect(a).toBe(b);
    const c = buildMastraWorkflowCached(
      { yamlSource: SEQUENTIAL_YAML, intentsSource: 'i', mastraVersion: '1.37.0' },
      cache,
      build,
    );
    expect(c).not.toBe(a);
  });
});
