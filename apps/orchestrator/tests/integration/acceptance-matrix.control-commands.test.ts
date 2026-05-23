/**
 * Phase 1 acceptance matrix — control commands (#32).
 *
 * Drives every DiscordGateway control command through the real
 * OrchestratorGatewayPort facade → engine + conductor, each with an explicit
 * assertion: /ask, /feedback, /pause, /resume, /cancel. (/run is covered by the
 * workflows matrix; /status is a thin read asserted here too.)
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { makeHarness, type AcceptanceHarness } from './acceptance-harness.js';

let harness: AcceptanceHarness;

afterEach(async () => {
  await harness.cleanup();
});

async function startCustom(h: AcceptanceHarness): Promise<string> {
  return h.gatewayPort.startTask({
    projectId: 'forgeroom',
    workflowId: 'custom',
    title: 'ctl task',
    description: 'control command target',
    source: 'discord-command',
  });
}

describe('acceptance matrix — control commands (#32)', () => {
  it('/pause then /resume: paused task resumes to completion', async () => {
    harness = await makeHarness();
    const taskId = await startCustom(harness);

    // custom suspends at pause_after → already paused.
    expect((await harness.store.getTask(taskId))?.status).toBe('paused');

    // /pause on an already-paused task is a no-op (still paused).
    await harness.gatewayPort.pauseTask(taskId);
    expect((await harness.store.getTask(taskId))?.status).toBe('paused');

    // /resume drives the suspended Mastra run to completion.
    await harness.gatewayPort.resumeTask(taskId);
    expect((await harness.store.getTask(taskId))?.status).toBe('done');
  });

  it('/cancel: a paused task becomes canceled and cannot be resumed', async () => {
    harness = await makeHarness();
    const taskId = await startCustom(harness);
    expect((await harness.store.getTask(taskId))?.status).toBe('paused');

    await harness.gatewayPort.cancelTask(taskId);
    expect((await harness.store.getTask(taskId))?.status).toBe('canceled');
    expect(harness.reporterEvents.some((e) => e.type === 'task_canceled')).toBe(true);

    // Worktree preserved on cancel.
    const wt = harness.worktreePathFor(taskId);
    await expect(stat(wt)).resolves.toBeTruthy();
    await expect(harness.gatewayPort.resumeTask(taskId)).rejects.toThrow(/canceled/);
  });

  it('/ask: returns a Conductor answer grounded in the task summary', async () => {
    harness = await makeHarness({
      // The conductor agent (claude) is the same fake; its "answer" output is
      // whatever the script returns for the conductor call (keyed by call kind).
      agentScript: { outputs: { answer: 'The plan covers two slices, each implemented and reviewed in turn.' } },
    });
    const taskId = await startCustom(harness);

    const answer = await harness.gatewayPort.askTask(taskId, 'How many slices?');
    expect(answer).toContain('two slices');
  });

  it('/feedback: records feedback and folds it into feedback.md (Pending) for the next step', async () => {
    harness = await makeHarness({
      agentScript: {
        outputs: {
          integrateFeedback: '- Prefer smaller, focused commits for this task\n- Add tests covering the new behavior',
        },
      },
    });
    const taskId = await startCustom(harness);

    await harness.gatewayPort.recordFeedback(taskId, 'please prefer smaller commits and add tests');

    const wt = harness.worktreePathFor(taskId);
    const feedback = await readFile(path.join(wt, '.forgeroom', 'context', 'feedback.md'), 'utf8');
    expect(feedback).toContain('## Pending for Next Step');
    expect(feedback).toContain('Prefer smaller, focused commits');
    expect(feedback).toContain('Add tests covering the new behavior');
  });

  it('/status: returns the live task row', async () => {
    harness = await makeHarness();
    const taskId = await startCustom(harness);
    const status = await harness.gatewayPort.getTaskStatus(taskId);
    expect(status?.id).toBe(taskId);
    expect(status?.workflow_id).toBe('custom');
    const active = await harness.gatewayPort.listActiveTasks('forgeroom');
    expect(active.some((t) => t.id === taskId)).toBe(true);
  });
});
