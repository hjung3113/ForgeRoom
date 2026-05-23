/**
 * Phase 1 acceptance matrix — safety & recovery (#32).
 *
 * Dedicated tests for each cross-cutting guarantee, driven against the real
 * engine + conductor + check-runner + forgemap + recoverPending:
 *   - dirty-baseline approval flow (ADR-013 engine/stager flow)
 *   - step-output validation retry (AgentRunner re-runs up to the cap)
 *   - check-fix retry (CheckRunner resume retry, fail-then-pass)
 *   - Conductor scope-guard revert (out-of-scope write reverted + logged + text kept)
 *   - restart recovery (kill mid-workflow → recoverPending → completes)
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  approvalAwareLookup,
  makeHarness,
  type AcceptanceHarness,
} from './acceptance-harness.js';

let harness: AcceptanceHarness;

afterEach(async () => {
  await harness.cleanup();
});

describe('acceptance matrix — dirty-baseline approval (ADR-013)', () => {
  it('blocks a task when the target repo is dirty and no maintainer approved', async () => {
    harness = await makeHarness({
      defaultWorkflow: 'hotfix',
      repoState: { commit: 'abc', dirty: true },
      taskLookup: approvalAwareLookup,
    });

    // runFull stages ForgeMap before the run; a dirty baseline with no approval
    // throws inside stage → settle records the task as failed.
    await expect(
      harness.gatewayPort.startTask({
        projectId: 'forgeroom',
        workflowId: 'hotfix',
        title: 'dirty start',
        description: 'd',
        source: 'discord-command',
      }),
    ).rejects.toThrow(/uncommitted changes|dirty/i);
  });

  it('proceeds once a maintainer approves the dirty baseline (note staged)', async () => {
    harness = await makeHarness({
      defaultWorkflow: 'hotfix',
      repoState: { commit: 'abc', dirty: true },
      taskLookup: approvalAwareLookup,
    });

    // The maintainer pre-approved the dirty baseline (a '*' approvals entry
    // models approval before runFull mints+stages the task id synchronously).
    harness.approvals.set('*', 'maintainer-octocat');
    const taskId = await harness.gatewayPort.startTask({
      projectId: 'forgeroom',
      workflowId: 'hotfix',
      title: 'approved dirty start',
      description: 'd',
      source: 'discord-command',
    });

    const task = await harness.store.getTask(taskId);
    expect(task?.status).toBe('done');
    const wt = harness.worktreePathFor(taskId);
    const manifest = await readFile(path.join(wt, '.forgeroom', 'context', 'selected-forgemap.md'), 'utf8');
    expect(manifest).toMatch(/dirty baseline: maintainer .* approved/);
  });
});

describe('acceptance matrix — step-output validation retry', () => {
  it('re-runs the agent when the first run writes no output, then completes', async () => {
    harness = await makeHarness({
      defaultWorkflow: 'hotfix',
      // The fix step writes no output on attempt 1; AgentRunner retries (cap 3).
      agentScript: { skipOutputUntilAttempt: { fix: 2 } },
    });

    const taskId = await harness.gatewayPort.startTask({
      projectId: 'forgeroom',
      workflowId: 'hotfix',
      title: 'retry task',
      description: 'd',
      source: 'discord-command',
    });

    const task = await harness.store.getTask(taskId);
    expect(task?.status).toBe('done');
    // The agent ran the fix step at least twice (attempt 1 empty, attempt 2 ok).
    expect(harness.openClaw.agentCalls.filter((s) => s === 'fix').length).toBeGreaterThanOrEqual(2);
    const wt = harness.worktreePathFor(taskId);
    await expect(stat(path.join(wt, '.forgeroom', 'outputs', '01_fix.md'))).resolves.toBeTruthy();
  });
});

describe('acceptance matrix — CheckRunner fix retry', () => {
  it('retries the kind:execute step once when checks fail, then passes', async () => {
    harness = await makeHarness({
      defaultWorkflow: 'quick',
      failChecksFirstAttempt: true,
      agentScript: { reviewFailUntilCall: { review: 1 } },
    });

    const taskId = await harness.gatewayPort.startTask({
      projectId: 'forgeroom',
      workflowId: 'quick',
      title: 'check retry',
      description: 'd',
      source: 'discord-command',
    });

    const task = await harness.store.getTask(taskId);
    expect(task?.status).toBe('done');
    // The implement step's checks failed the first batch, then a check-fix
    // resume re-ran the agent and the second batch passed.
    const steps = await harness.store.listSteps(taskId);
    const implStep = steps.find((s) => s.step_id === 'implement');
    expect(implStep?.check_status).toBe('fixed');
  });
});

describe('acceptance matrix — Conductor scope-guard revert', () => {
  it('reverts an out-of-scope write, logs the violation, and preserves the answer text', async () => {
    harness = await makeHarness({
      defaultWorkflow: 'hotfix',
      agentScript: { outputs: { answer: 'Two slices remain to be implemented before this task is complete.' } },
    });

    const taskId = await harness.gatewayPort.startTask({
      projectId: 'forgeroom',
      workflowId: 'hotfix',
      title: 'scope task',
      description: 'd',
      source: 'discord-command',
    });

    // Arm an out-of-scope write for the NEXT conductor call (the /ask below):
    // the guard sees a clean "before" then `src/leak.ts` "after" → it reverts.
    harness.conductorGit.armViolation(['src/leak.ts']);
    const answer = await harness.gatewayPort.askTask(taskId, 'How many slices remain?');

    // Text output ALWAYS preserved (conductor.md), even on a scope violation.
    expect(answer).toContain('Two slices remain');
    // The out-of-scope file was reverted and the violation logged.
    expect(harness.conductorGit.reverted.flat()).toContain('src/leak.ts');
    const wt = harness.worktreePathFor(taskId);
    const log = await readFile(
      path.join(wt, '.forgeroom', 'logs', 'conductor_scope_violation.log'),
      'utf8',
    );
    expect(log).toContain('src/leak.ts');
    expect(harness.conductorLog.some((l) => l.includes('scope violation'))).toBe(true);
  });
});

describe('acceptance matrix — restart recovery', () => {
  it('kills mid-workflow at a pause checkpoint, recoverPending resumes to done', async () => {
    harness = await makeHarness();
    const taskId = await harness.gatewayPort.startTask({
      projectId: 'forgeroom',
      workflowId: 'custom',
      title: 'recover task',
      description: 'd',
      source: 'discord-command',
    });
    // custom paused at its gate; mastra_run_id recorded → a fresh process can
    // resume the suspended run.
    expect((await harness.store.getTask(taskId))?.status).toBe('paused');
    expect(await harness.store.getMastraRunId(taskId)).toBeTruthy();

    // Simulate a process restart: brand-new engine + snapshot bridge, same
    // on-disk sqlite + snapshot dir.
    const restarted = harness.rebuild();
    await restarted.engine.recoverPending();

    expect((await restarted.store.getTask(taskId))?.status).toBe('done');
  });

  it('recovers a fresh-replay task (no usable snapshot) to completion', async () => {
    harness = await makeHarness({ defaultWorkflow: 'hotfix' });
    // Seed a paused task with no mastra_run_id → recoverPending replays fresh.
    const taskId = 'seed-recover';
    const wt = harness.worktreePathFor(taskId);
    await harness.store.startTask({
      id: taskId,
      project_id: 'forgeroom',
      workflow_id: 'hotfix',
      title: 'seed',
      description: 'd',
      status: 'paused',
      source: 'discord-command',
      external_ref: null,
      issue_number: null,
      branch_name: `forge/${taskId}`,
      worktree_path: wt,
      pr_number: null,
      final_slices: [],
      vars: {},
      mastra_run_id: null,
    });

    const restarted = harness.rebuild();
    await restarted.engine.recoverPending();

    expect((await restarted.store.getTask(taskId))?.status).toBe('done');
    await expect(stat(path.join(wt, '.forgeroom', 'outputs', '01_fix.md'))).resolves.toBeTruthy();
  });
});
