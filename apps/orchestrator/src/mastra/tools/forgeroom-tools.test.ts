import { describe, expect, it } from 'vitest';

import { buildForgeRoomTools, type ForgeRoomToolDeps } from './forgeroom-tools.js';
import type { Task, Step } from '../../core/types.js';

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    project_id: 'forgeroom',
    workflow_id: 'full',
    title: 'Add login',
    description: 'd',
    status: 'done',
    failure_reason: null,
    source: 'github-issue-label',
    external_ref: null,
    issue_number: 7,
    branch_name: 'forgeroom/task-1',
    worktree_path: '/wt/task-1',
    pr_number: 12,
    final_slices: [],
    vars: {},
    ...over,
  } as Task;
}

function step(over: Partial<Step> = {}): Step {
  return {
    id: 'srow-1',
    task_id: 'task-1',
    step_id: 'execute',
    parent_step_id: null,
    iteration: 0,
    agent_id: 'codex',
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
    openclaw_session_id: 'oc-1',
    openclaw_agent_key: 'fr-impl',
    openclaw_role: 'implementer',
    ...over,
  };
}

const projectMeta = {
  id: 'forgeroom',
  path: '/abs/forgeroom',
  default_branch: 'main',
  package_manager: 'pnpm',
  default_workflow: 'full',
  allowed_workflows: ['full', 'quick'],
  template_dir: null,
  commands: { lint: 'l', typecheck: 't', test: 'x' },
  maintainers: { discord_user_ids: [], github_logins: [] },
};

function deps(): ForgeRoomToolDeps {
  return {
    projects: {
      list: () => [projectMeta],
      get: (id) => (id === 'forgeroom' ? projectMeta : null),
      getRoom: (id) =>
        id === 'forgeroom'
          ? { project: projectMeta, openclaw: { agents: { implementer: 'fr-impl' } } }
          : null,
    },
    taskStore: {
      getTask: async (id) => (id === 'task-1' ? task() : null),
      listSteps: async () => [step()],
      listTasksByProject: async () => [task(), task({ id: 'task-2', status: 'failed' })],
      listActiveTasks: async () => [task({ id: 'task-3', status: 'running' })],
    },
  };
}

// Minimal invoker — createTool's execute receives the validated input directly.
/* eslint-disable @typescript-eslint/no-explicit-any */
async function run(tool: ReturnType<typeof buildForgeRoomTools>[string], input: unknown): Promise<any> {
  return (tool.execute as (a: unknown) => Promise<any>)(input);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('ForgeRoom read-only Mastra tools (Phase 2C)', () => {
  const tools = buildForgeRoomTools(deps());

  it('exposes the read-only tool set', () => {
    expect(Object.keys(tools).sort()).toEqual([
      'forgeroom_project_list',
      'forgeroom_project_status',
      'forgeroom_room_state',
      'forgeroom_task_list',
      'forgeroom_task_read',
      'forgeroom_task_timeline',
    ]);
  });

  it('project_list returns project metadata', async () => {
    const out = await run(tools.forgeroom_project_list!, {});
    expect(out.projects).toEqual([
      { id: 'forgeroom', path: '/abs/forgeroom', default_workflow: 'full', allowed_workflows: ['full', 'quick'] },
    ]);
  });

  it('project_status returns the room view, or found:false for unknown', async () => {
    const ok = await run(tools.forgeroom_project_status!, { projectId: 'forgeroom' });
    expect(ok).toMatchObject({ found: true, openclaw: { agents: { implementer: 'fr-impl' } } });
    const miss = await run(tools.forgeroom_project_status!, { projectId: 'nope' });
    expect(miss).toEqual({ found: false, projectId: 'nope' });
  });

  it('task_list summarizes recent tasks', async () => {
    const out = await run(tools.forgeroom_task_list!, { projectId: 'forgeroom' });
    expect(out.tasks.map((t: { id: string }) => t.id)).toEqual(['task-1', 'task-2']);
  });

  it('task_timeline includes OpenClaw session handles', async () => {
    const out = await run(tools.forgeroom_task_timeline!, { taskId: 'task-1' });
    expect(out.steps[0]).toMatchObject({
      step_id: 'execute',
      openclaw_session_id: 'oc-1',
      openclaw_role: 'implementer',
    });
  });

  it('room_state reports active tasks', async () => {
    const out = await run(tools.forgeroom_room_state!, { projectId: 'forgeroom' });
    expect(out).toMatchObject({ configured: true, default_workflow: 'full' });
    expect(out.active_tasks[0].id).toBe('task-3');
  });
});
