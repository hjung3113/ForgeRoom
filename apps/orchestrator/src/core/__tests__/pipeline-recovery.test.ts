import { describe, expect, it } from 'vitest';

import { makePipelineHarness, task } from '../test-support/pipeline-engine-fixtures';
import type { ResolvedExecutableStep } from '../workflow-registry';

describe('PipelineEngine recovery', () => {
  it('continues active tasks after the last done step', async () => {
    const harness = makePipelineHarness({
      workflowSteps: [runStep('plan', 'plan.md'), runStep('implement', 'implement.md')],
      templates: [
        ['plan.md', 'Plan\n'],
        ['implement.md', 'Implement\n'],
      ],
    });
    const activeTask = task({ status: 'running' });
    harness.taskStore.seedTask(activeTask);
    harness.taskStore.seedStep({ task_id: activeTask.id, step_id: 'plan', status: 'done' });

    await harness.engine.recoverPending();

    expect(harness.agentRunner.runs).toMatchObject([
      { promptPath: '/tmp/forgeroom/worktrees/task-1/.forgeroom/prompts/02_implement.md' },
    ]);
  });

  it('restarts a running step and leaves failed tasks for user decision', async () => {
    const harness = makePipelineHarness({
      workflowSteps: [runStep('plan', 'plan.md'), runStep('implement', 'implement.md')],
      templates: [
        ['plan.md', 'Plan\n'],
        ['implement.md', 'Implement\n'],
      ],
    });
    const runningTask = task({ id: 'task-running', status: 'running' });
    const failedTask = task({ id: 'task-failed', status: 'running' });
    harness.taskStore.seedTask(runningTask);
    harness.taskStore.seedTask(failedTask);
    harness.taskStore.seedStep({ task_id: runningTask.id, step_id: 'implement', status: 'running' });
    harness.taskStore.seedStep({ task_id: failedTask.id, step_id: 'plan', status: 'failed' });

    await harness.engine.recoverPending();

    expect(harness.agentRunner.runs).toHaveLength(1);
    expect(harness.agentRunner.runs[0]).toMatchObject({
      cwd: '/tmp/forgeroom/worktrees/task-running',
      promptPath: '/tmp/forgeroom/worktrees/task-running/.forgeroom/prompts/02_implement.md',
    });
  });
});

function runStep(id: string, promptTemplate: string): ResolvedExecutableStep {
  return {
    type: 'run',
    id,
    intent: 'codex_execute',
    prompt_template: promptTemplate,
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
    kind: 'write_plan',
    agent: 'codex',
    harness: 'planning',
  };
}
