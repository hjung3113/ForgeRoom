import { describe, expect, it } from 'vitest';

import { makePipelineHarness } from '../test-support/pipeline-engine-fixtures';
import type { ResolvedExecutableStep, ResolvedStep } from '../workflow-registry';

describe('PipelineEngine review_loop execution', () => {
  it('runs review, refine, and review again under one control step until the review passes', async () => {
    const harness = makePipelineHarness({
      workflowSteps: [
        reviewLoop({
          maxIterations: 1,
          refineKind: 'execute',
        }),
      ],
      templates: [
        ['review.md', 'Review diff\n'],
        ['refine.md', 'Refine from review\n'],
      ],
      agentOutputs: ['Review Result: fail\nNeeds changes\n', 'Refined\n', 'Review Result: pass\nDone\n'],
    });

    await harness.engine.runFull('forge', {
      title: 'Review loop',
      description: 'Exercise review loop.',
      source: 'discord-command',
    });

    expect(harness.taskStore.createdSteps).toMatchObject([
      { id: 'step-1', step_id: 'quality_gate', parent_step_id: null, iteration: 0, agent_id: 'pipeline' },
      { id: 'step-2', step_id: 'review_diff', parent_step_id: 'step-1', iteration: 0 },
      { id: 'step-3', step_id: 'refine_impl', parent_step_id: 'step-1', iteration: 0 },
      { id: 'step-4', step_id: 'review_diff', parent_step_id: 'step-1', iteration: 1 },
    ]);
    expect(harness.checkRunner.requests).toHaveLength(1);
    expect(harness.checkRunner.requests[0]?.step).toMatchObject({ id: 'step-3', step_id: 'refine_impl' });
    expect(harness.taskStore.stepPatches).toContainEqual({
      id: 'step-1',
      patch: { status: 'done', finished_at: harness.now },
    });
  });

  it('fails the loop and task when max refine iterations are exhausted', async () => {
    const harness = makePipelineHarness({
      workflowSteps: [reviewLoop({ maxIterations: 1, refineKind: 'execute' })],
      templates: [
        ['review.md', 'Review diff\n'],
        ['refine.md', 'Refine from review\n'],
      ],
      agentOutputs: ['Review Result: fail\nNeeds changes\n', 'Refined\n', 'Review Result: fail\nStill failing\n'],
    });

    await harness.engine.runFull('forge', {
      title: 'Review loop failure',
      description: 'Exhaust review loop.',
      source: 'discord-command',
    });

    expect(harness.taskStore.stepPatches).toContainEqual({
      id: 'step-1',
      patch: {
        status: 'failed',
        failure_reason: 'review_loop_max_iterations',
        finished_at: harness.now,
      },
    });
    expect(harness.taskStore.taskStatusUpdates).toContainEqual({
      id: 'task-1',
      status: 'failed',
      failureReason: 'review_loop_max_iterations',
    });
  });
});

function reviewLoop(options: { maxIterations: number; refineKind: string }): ResolvedStep {
  return {
    type: 'review_loop',
    id: 'quality_gate',
    intent: null,
    prompt_template: null,
    input_refs: {},
    vars: {},
    foreach: null,
    as: null,
    steps: [],
    review: executableStep({
      id: 'review_diff',
      intent: 'codex_review',
      promptTemplate: 'review.md',
      kind: 'review',
      harness: 'review',
    }),
    refine: executableStep({
      id: 'refine_impl',
      intent: 'codex_execute',
      promptTemplate: 'refine.md',
      kind: options.refineKind,
      harness: 'implementation',
    }),
    until: '${review_diff.passed}',
    max_iterations: options.maxIterations,
    pause_after: false,
    kind: null,
    agent: null,
    harness: null,
  };
}

function executableStep(options: {
  id: string;
  intent: string;
  promptTemplate: string;
  kind: string;
  harness: string;
}): ResolvedExecutableStep {
  return {
    type: 'run',
    id: options.id,
    intent: options.intent,
    prompt_template: options.promptTemplate,
    input_refs: {},
    vars: {},
    foreach: null,
    as: null,
    steps: [],
    review: null,
    refine: null,
    until: null,
    max_iterations: null,
    pause_after: false,
    kind: options.kind,
    agent: 'codex',
    harness: options.harness,
  };
}
