/**
 * Phase 1 acceptance matrix — happy-path workflows (#32).
 *
 * One project + the three provided workflows (`quick` / `hotfix` / `full`) + a
 * `custom` workflow selected from allowed_workflows, each driven end-to-end
 * through the gateway facade → real engine → real conductor/check-runner/
 * forgemap/agent-runner over the fake OpenClaw IPC. Each asserts the expected
 * `.forgeroom/` files were produced and the task reached its terminal status.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { makeHarness, PLAN_OUTPUT, type AcceptanceHarness } from './acceptance-harness.js';

let harness: AcceptanceHarness;

afterEach(async () => {
  await harness.cleanup();
});

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('acceptance matrix — provided + custom workflows (#32)', () => {
  it('quick: plan → implement(+checks) → review_loop runs to done with .forgeroom artifacts', async () => {
    harness = await makeHarness({
      defaultWorkflow: 'quick',
      agentScript: { outputs: { plan: PLAN_OUTPUT }, reviewFailUntilCall: { review: 1 } },
    });

    const taskId = await harness.gatewayPort.startTask({
      projectId: 'forgeroom',
      workflowId: 'quick',
      title: 'quick task',
      description: 'do the quick thing',
      source: 'discord-command',
    });

    const task = await harness.store.getTask(taskId);
    expect(task?.status).toBe('done');

    const wt = harness.worktreePathFor(taskId);
    // ForgeMap staged context, conductor seeded summary, agent produced outputs.
    expect(await exists(path.join(wt, '.forgeroom', 'context', 'selected-forgemap.md'))).toBe(true);
    expect(await exists(path.join(wt, '.forgeroom', 'context', 'summary.md'))).toBe(true);
    const planOut = await readFile(path.join(wt, '.forgeroom', 'outputs', '01_plan.md'), 'utf8');
    expect(planOut).toContain('## Slices');
    expect(await exists(path.join(wt, '.forgeroom', 'prompts', '01_plan.md'))).toBe(true);

    // CheckRunner ran the project commands for the kind:execute step.
    expect(harness.commandRunner.runs).toContain('echo lint');
    // A PR was created (effects.external.pr=ready) and recorded.
    expect(harness.prCreator.ensured.length).toBeGreaterThanOrEqual(1);
    expect(task?.pr_number).toBe(42);
    expect(harness.reporterEvents.some((e) => e.type === 'pr_created')).toBe(true);
  });

  it('hotfix: linear execute → review runs to done', async () => {
    // The standalone `review` step must emit the `Review Result:` contract.
    harness = await makeHarness({ defaultWorkflow: 'hotfix', agentScript: { reviewFailUntilCall: { review: 1 } } });

    const taskId = await harness.gatewayPort.startTask({
      projectId: 'forgeroom',
      workflowId: 'hotfix',
      title: 'urgent fix',
      description: 'patch it',
      source: 'discord-command',
    });

    const task = await harness.store.getTask(taskId);
    expect(task?.status).toBe('done');
    const wt = harness.worktreePathFor(taskId);
    expect(await exists(path.join(wt, '.forgeroom', 'outputs', '01_fix.md'))).toBe(true);
    expect(await exists(path.join(wt, '.forgeroom', 'outputs', '02_review.md'))).toBe(true);
  });

  it('full: plan → refine → foreach slices → final review_loop runs to done', async () => {
    harness = await makeHarness({
      defaultWorkflow: 'full',
      agentScript: { outputs: { impl_plan: PLAN_OUTPUT }, reviewFailUntilCall: { final_review: 1 } },
    });

    const taskId = await harness.gatewayPort.startTask({
      projectId: 'forgeroom',
      workflowId: 'full',
      title: 'full pipeline',
      description: 'design and build',
      source: 'github-issue-label',
      issueNumber: 7,
    });

    const task = await harness.store.getTask(taskId);
    expect(task?.status).toBe('done');
    // final_slices parsed from the plan, foreach ran slice_impl per slice.
    expect(task?.final_slices).toEqual(['first slice', 'second slice']);
    const sliceCalls = harness.openClaw.agentCalls.filter((s) => s === 'slice_impl');
    expect(sliceCalls.length).toBe(2);
  });

  it('custom (selected from allowed_workflows): runs and suspends at its pause gate', async () => {
    harness = await makeHarness({ defaultWorkflow: 'quick' });

    const taskId = await harness.gatewayPort.startTask({
      projectId: 'forgeroom',
      workflowId: 'custom',
      title: 'custom flow',
      description: 'run the project-author workflow',
      source: 'discord-command',
    });

    // custom ends with pause_after: true → suspends → paused (not done).
    const task = await harness.store.getTask(taskId);
    expect(task?.status).toBe('paused');
    const wt = harness.worktreePathFor(taskId);
    expect(await exists(path.join(wt, '.forgeroom', 'outputs', '01_build.md'))).toBe(true);
  });

  it('rejects a workflow outside allowed_workflows (admission guard)', async () => {
    harness = await makeHarness({ allowedWorkflows: ['quick'], defaultWorkflow: 'quick' });
    await expect(
      harness.gatewayPort.startTask({
        projectId: 'forgeroom',
        workflowId: 'full',
        title: 't',
        description: 'd',
        source: 'discord-command',
      }),
    ).rejects.toThrow(/not allowed/);
  });
});
