import { Mastra } from '@mastra/core';
import { MockStore } from '@mastra/core/storage';
import { describe, expect, it } from 'vitest';

import { buildSampleWorkflow } from './sample-workflow.js';
import { SAMPLE_WORKFLOW_ID } from './sample-config.js';

describe('buildSampleWorkflow (Studio sample graph)', () => {
  it('builds the full workflow graph from the inline sample yaml', () => {
    const built = buildSampleWorkflow();
    expect((built.workflow as { id: string }).id).toBe(SAMPLE_WORKFLOW_ID);
    // The full workflow declares plan, refine, the foreach slice impl, and the
    // review_loop review/refine — all resolved steps must be present so the
    // Studio graph renders the complete shape.
    const ids = built.resolvedSteps.map((s) => s.stepId);
    expect(ids).toEqual(
      expect.arrayContaining(['impl_plan', 'impl_plan_refine', 'slice_impl', 'final_review', 'final_refine']),
    );
  });

  it('runs end to end with stub agents and produces a successful, complete trace', async () => {
    const built = buildSampleWorkflow();
    const storage = new MockStore();
    const mastra = new Mastra({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      workflows: { [SAMPLE_WORKFLOW_ID]: built.workflow as any },
      storage,
      logger: false,
    });

    const run = await mastra.getWorkflow(SAMPLE_WORKFLOW_ID).createRun();
    const result = await run.start({ inputData: {} });

    // No LLM/CLI ran, yet every step completed: the stub plan emitted slices
    // (foreach ran) and the stub review emitted passed:true (review_loop
    // terminated on iteration 1).
    expect(result.status).toBe('success');

    // A run snapshot is persisted to the store Studio reads from, so the trace
    // timeline has step records to render.
    const snapshot = await storage
      .getStore('workflows')
      .then((s) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (s as any).loadWorkflowSnapshot({ workflowName: SAMPLE_WORKFLOW_ID, runId: run.runId }),
      );
    expect(snapshot).not.toBeNull();
  });
});
