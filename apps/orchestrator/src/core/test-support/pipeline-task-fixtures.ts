import type { Step, Task } from '../types';

export function task(overrides: Partial<Task> = {}): Task {
  const id = overrides.id ?? 'task-1';
  return {
    id,
    project_id: 'forge',
    workflow_id: 'feature',
    title: 'Recovered task',
    description: 'Recover this task.',
    status: 'running',
    failure_reason: null,
    source: 'discord-command',
    external_ref: null,
    issue_number: null,
    branch_name: `forgeroom/${id}`,
    worktree_path: `/tmp/forgeroom/worktrees/${id}`,
    pr_number: null,
    final_slices: [],
    vars: {},
    created_at: new Date('2026-05-23T00:00:00.000Z'),
    updated_at: new Date('2026-05-23T00:00:00.000Z'),
    ...overrides,
  };
}

export function step(overrides: Partial<Step> & Pick<Step, 'task_id' | 'step_id' | 'status'>): Step {
  return {
    id: `${overrides.task_id}-${overrides.step_id}`,
    parent_step_id: null,
    iteration: 0,
    agent_id: 'codex',
    failure_reason: null,
    attempt: 1,
    check_fix_attempt: 0,
    check_status: 'not_run',
    prompt_path: '/tmp/prompt.md',
    output_path: '/tmp/output.md',
    diff_path: null,
    exit_code: null,
    started_at: new Date('2026-05-23T00:00:00.000Z'),
    finished_at: null,
    ...overrides,
  };
}
