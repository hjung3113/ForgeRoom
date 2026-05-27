import { describe, expect, it } from 'vitest';

import { buildRoomState, type RoomStateDeps } from './room-state.js';
import type { Task, Step } from '../types.js';

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    project_id: 'forgeroom',
    workflow_id: 'full',
    title: 'Add login',
    description: 'd',
    status: 'running',
    failure_reason: null,
    source: 'github-issue-label',
    external_ref: null,
    issue_number: 7,
    branch_name: 'b',
    worktree_path: '/wt',
    pr_number: null,
    final_slices: [],
    vars: {},
    ...over,
  } as Task;
}

function step(over: Partial<Step> = {}): Step {
  return {
    id: 's',
    task_id: 'task-1',
    step_id: 'plan',
    parent_step_id: null,
    iteration: 0,
    agent_id: 'claude',
    status: 'done',
    failure_reason: null,
    attempt: 1,
    check_fix_attempt: 0,
    check_status: 'not_run',
    prompt_path: 'p',
    output_path: 'o',
    diff_path: null,
    exit_code: 0,
    started_at: new Date('2026-05-26T00:00:00Z'),
    finished_at: new Date('2026-05-26T00:01:00Z'),
    openclaw_session_id: null,
    openclaw_agent_key: null,
    openclaw_role: null,
    ...over,
  };
}

const projectMeta = {
  id: 'forgeroom',
  path: '/abs',
  default_branch: 'main',
  package_manager: 'pnpm',
  default_workflow: 'full',
  allowed_workflows: ['full'],
  template_dir: null,
  commands: { lint: 'l', typecheck: 't', test: 'x' },
  maintainers: { discord_user_ids: [], github_logins: [] },
};

const NOW = (): Date => new Date('2026-05-26T12:00:00Z');

describe('buildRoomState (Phase 2D read-model)', () => {
  it('snapshots config, active tasks with active step, recent tasks, and sessions', async () => {
    const deps: RoomStateDeps = {
      projects: { getRoom: () => ({ project: projectMeta }) },
      taskStore: {
        listActiveTasks: async () => [task()],
        listTasksByProject: async () => [task(), task({ id: 'task-0', status: 'done', pr_number: 5 })],
        listSteps: async () => [
          step({ step_id: 'plan', status: 'done' }),
          step({ step_id: 'execute', status: 'running', openclaw_session_id: 'oc-1', openclaw_role: 'implementer', openclaw_agent_key: 'fr-impl' }),
        ],
      },
    };

    const state = await buildRoomState(deps, 'forgeroom', NOW);

    expect(state).toMatchObject({
      project_id: 'forgeroom',
      generated_at: '2026-05-26T12:00:00.000Z',
      configured: true,
      default_workflow: 'full',
    });
    expect(state.active_tasks[0]).toMatchObject({ id: 'task-1', status: 'running', active_step: 'execute' });
    expect(state.recent_tasks.map((t) => t.id)).toEqual(['task-1', 'task-0']);
    expect(state.sessions).toEqual([
      { task_id: 'task-1', step_id: 'execute', role: 'implementer', agent_key: 'fr-impl', session_id: 'oc-1' },
    ]);
  });

  it('marks unconfigured projects and emits empty collections', async () => {
    const deps: RoomStateDeps = {
      projects: { getRoom: () => null },
      taskStore: {
        listActiveTasks: async () => [],
        listTasksByProject: async () => [],
        listSteps: async () => [],
      },
    };
    const state = await buildRoomState(deps, 'ghost', NOW);
    expect(state).toMatchObject({ configured: false, default_workflow: null, active_tasks: [], sessions: [] });
  });
});
