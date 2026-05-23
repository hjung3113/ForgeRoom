import { describe, expect, it } from 'vitest';

import { WorkflowError } from '../errors';
import { makePipelineHarness } from '../test-support/pipeline-engine-fixtures';

describe('DefaultPipelineEngine', () => {
  it('starts a task, prepares the worktree, writes the first prompt, and runs the first step', async () => {
    const harness = makePipelineHarness();

    const taskId = await harness.engine.runFull('forge', {
      title: 'Add orchestration',
      description: 'Implement the first slice.',
      source: 'discord-command',
    });

    expect(taskId).toBe('task-1');
    expect(harness.taskStore.createdTasks).toMatchObject([
      {
        id: 'task-1',
        project_id: 'forge',
        workflow_id: 'feature',
        title: 'Add orchestration',
        branch_name: 'forgeroom/task-1-add-orchestration',
        worktree_path: '/tmp/forgeroom/worktrees/task-1',
        status: 'queued',
      },
    ]);
    expect(harness.taskStore.lockRequests).toEqual([{ projectId: 'forge', taskId: 'task-1' }]);
    expect(harness.worktreeManager.createdTasks.map((task) => task.id)).toEqual(['task-1']);
    expect(harness.artifactStore.files.get('/tmp/forgeroom/worktrees/task-1/.forgeroom/prompts/01_plan.md')).toContain(
      'Implement the first slice.',
    );
    expect(harness.agentRunner.runs).toMatchObject([
      {
        agentId: 'codex',
        promptPath: '/tmp/forgeroom/worktrees/task-1/.forgeroom/prompts/01_plan.md',
        outputPath: '/tmp/forgeroom/worktrees/task-1/.forgeroom/outputs/01_plan.md',
        cwd: '/tmp/forgeroom/worktrees/task-1',
        mode: 'headless',
      },
    ]);
    expect(harness.taskStore.createdSteps).toMatchObject([
      {
        task_id: 'task-1',
        step_id: 'plan',
        agent_id: 'codex',
        status: 'running',
        prompt_path: '/tmp/forgeroom/worktrees/task-1/.forgeroom/prompts/01_plan.md',
        output_path: '/tmp/forgeroom/worktrees/task-1/.forgeroom/outputs/01_plan.md',
      },
    ]);
    expect(harness.taskStore.stepPatches).toEqual([
      {
        id: 'step-1',
        patch: {
          status: 'done',
          exit_code: 0,
          finished_at: harness.now,
        },
      },
    ]);
    expect(harness.taskStore.releaseLockRequests).toEqual([{ projectId: 'forge', taskId: 'task-1' }]);
  });

  it('runs CheckRunner only for execute steps after agent output is produced', async () => {
    const harness = makePipelineHarness({ firstStepKind: 'execute' });

    await harness.engine.runFull('forge', {
      title: 'Implement execution',
      description: 'Write code and verify it.',
      source: 'discord-command',
    });

    expect(harness.checkRunner.requests).toHaveLength(1);
    expect(harness.checkRunner.requests[0]).toMatchObject({
      task: { id: 'task-1', project_id: 'forge' },
      step: { id: 'step-1', step_id: 'plan' },
      project: { id: 'forge' },
    });
  });

  it('refreshes final slices from refine output before running the slice group', async () => {
    const harness = makePipelineHarness({
      workflowSteps: [
        {
          type: 'run',
          id: 'implementation_plan',
          intent: 'codex_plan',
          prompt_template: 'implementation_plan.md',
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
        },
        {
          type: 'run',
          id: 'refine_plan',
          intent: 'codex_plan',
          prompt_template: 'refine_plan.md',
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
        },
        {
          type: 'group',
          id: 'implement_slices',
          intent: null,
          prompt_template: null,
          input_refs: {},
          vars: {},
          foreach: '${task.final_slices}',
          as: 'slice',
          steps: [
            {
              type: 'run',
              id: 'slice_impl',
              intent: 'codex_execute',
              prompt_template: 'slice_impl.md',
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
              kind: 'execute',
              agent: 'codex',
              harness: 'implementation',
            },
          ],
          review: null,
          refine: null,
          until: null,
          max_iterations: null,
          pause_after: false,
          kind: null,
          agent: null,
          harness: null,
        },
      ],
      templates: [
        ['implementation_plan.md', 'Plan ${task.title}\n'],
        ['refine_plan.md', 'Refine plan\n'],
        ['slice_impl.md', 'Implement ${slice}\n'],
      ],
      agentOutputs: [
        '## Slices\n- Initial slice\n',
        '## Slices\n- Refined slice A\n- Refined slice B\n',
        'Implemented A\n',
        'Implemented B\n',
      ],
    });

    await harness.engine.runFull('forge', {
      title: 'Slice orchestration',
      description: 'Use refined slices.',
      source: 'discord-command',
    });

    expect([...harness.artifactStore.files.values()].filter((content) => content.startsWith('Implement '))).toEqual([
      'Implement Refined slice A\n',
      'Implement Refined slice B\n',
    ]);
  });

  it('does not mark an execute step done when CheckRunner fails after its fix attempt', async () => {
    const harness = makePipelineHarness({ firstStepKind: 'execute', checksPass: false });

    await harness.engine.runFull('forge', {
      title: 'Implement execution',
      description: 'Write code and verify it.',
      source: 'discord-command',
    });

    expect(harness.taskStore.stepPatches).toEqual([]);
  });

  it('marks the task failed when the first agent step fails', async () => {
    const harness = makePipelineHarness({ agentFailureKind: 'agent_error' });

    await harness.engine.runFull('forge', {
      title: 'Fail orchestration',
      description: 'Provider fails before producing usable output.',
      source: 'discord-command',
    });

    expect(harness.taskStore.stepPatches).toEqual([
      {
        id: 'step-1',
        patch: {
          status: 'failed',
          exit_code: 1,
          failure_reason: 'agent_error',
          finished_at: harness.now,
        },
      },
    ]);
    expect(harness.taskStore.taskStatusUpdates).toEqual([
      { id: 'task-1', status: 'failed', failureReason: 'agent_error' },
    ]);
    expect(harness.taskStore.releaseLockRequests).toEqual([{ projectId: 'forge', taskId: 'task-1' }]);
  });

  it('cancels an active task and releases its project lock', async () => {
    const harness = makePipelineHarness();
    const taskId = await harness.engine.runFull('forge', {
      title: 'Cancelable orchestration',
      description: 'Prepare a task that can be canceled.',
      source: 'discord-command',
    });

    await harness.engine.cancel(taskId);

    expect(harness.taskStore.cancelRequests).toEqual([
      {
        taskId: 'task-1',
        eventId: harness.taskStore.cancelRequests[0]?.eventId,
        payload: { reason: 'user_requested' },
      },
    ]);
    expect(harness.taskStore.releaseLockRequests).toEqual([
      { projectId: 'forge', taskId: 'task-1' },
      { projectId: 'forge', taskId: 'task-1' },
    ]);
  });

  it('pauses and resumes a task through explicit lifecycle commands', async () => {
    const harness = makePipelineHarness();
    const taskId = await harness.engine.runFull('forge', {
      title: 'Pause orchestration',
      description: 'Prepare a task that can be paused.',
      source: 'discord-command',
    });

    await harness.engine.pause(taskId);
    await harness.engine.resume(taskId);

    expect(harness.taskStore.taskStatusUpdates).toEqual([
      { id: 'task-1', status: 'paused' },
      { id: 'task-1', status: 'running' },
    ]);
    expect(harness.taskStore.lockRequests).toEqual([
      { projectId: 'forge', taskId: 'task-1' },
      { projectId: 'forge', taskId: 'task-1' },
    ]);
  });

  it('does not resume canceled tasks', async () => {
    const harness = makePipelineHarness();
    const taskId = await harness.engine.runFull('forge', {
      title: 'Canceled orchestration',
      description: 'Prepare a canceled task.',
      source: 'discord-command',
    });
    harness.taskStore.setTaskStatus(taskId, 'canceled');

    await expect(harness.engine.resume(taskId)).rejects.toThrow(WorkflowError);
  });
});
