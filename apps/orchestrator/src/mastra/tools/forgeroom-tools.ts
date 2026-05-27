/**
 * ForgeRoom read-only operator tools for Mastra Studio (Phase 2C, roadmap-v3).
 *
 * These surface ForgeRoom state (projects, project rooms, tasks, step timeline,
 * OpenClaw session handles) inside the Studio tools playground. They are
 * STRICTLY READ-ONLY — no task mutation, no approvals (write tools come later,
 * behind ApprovalGate). Built from narrow store/registry interfaces so they
 * unit-test with fakes and never reach for a real LLM or subprocess.
 *
 * Filesystem-backed reads (diff.read, check.logs) are intentionally deferred —
 * they need worktree artifact access and are tracked separately.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import type { ProjectRegistry } from '../../core/registries/project-registry.js';
import type { TaskStore } from '../../core/task-store.js';
import type { Task } from '../../core/types.js';

export interface ForgeRoomToolDeps {
  projects: Pick<ProjectRegistry, 'list' | 'get' | 'getRoom'>;
  taskStore: Pick<TaskStore, 'getTask' | 'listSteps' | 'listTasksByProject' | 'listActiveTasks'>;
}

const DEFAULT_TASK_LIMIT = 20;

function taskSummary(task: Task): Record<string, unknown> {
  return {
    id: task.id,
    project_id: task.project_id,
    workflow_id: task.workflow_id,
    title: task.title,
    status: task.status,
    failure_reason: task.failure_reason,
    issue_number: task.issue_number,
    pr_number: task.pr_number,
  };
}

/**
 * Build the read-only ForgeRoom tool map. Keyed by tool id so a Mastra instance
 * can spread them into its `tools` option.
 */
export function buildForgeRoomTools(deps: ForgeRoomToolDeps): Record<string, ReturnType<typeof createTool>> {
  const projectList = createTool({
    id: 'forgeroom_project_list',
    description: 'List ForgeRoom projects (id, path, default workflow). Read-only.',
    inputSchema: z.object({}),
    execute: async () => ({
      projects: deps.projects.list().map((p) => ({
        id: p.id,
        path: p.path,
        default_workflow: p.default_workflow,
        allowed_workflows: p.allowed_workflows,
      })),
    }),
  });

  const projectStatus = createTool({
    id: 'forgeroom_project_status',
    description: 'Project Room view for a project: workflows + reserved discord/openclaw/mastra config. Read-only.',
    inputSchema: z.object({ projectId: z.string() }),
    execute: async (input) => {
      const room = deps.projects.getRoom(input.projectId);
      if (room === null) {
        return { found: false as const, projectId: input.projectId };
      }
      return {
        found: true as const,
        id: room.project.id,
        default_workflow: room.project.default_workflow,
        allowed_workflows: room.project.allowed_workflows,
        discord: room.discord ?? null,
        openclaw: room.openclaw ?? null,
        mastra: room.mastra ?? null,
      };
    },
  });

  const taskList = createTool({
    id: 'forgeroom_task_list',
    description: 'Recent tasks for a project (newest first, all statuses). Read-only.',
    inputSchema: z.object({ projectId: z.string(), limit: z.number().int().positive().max(100).optional() }),
    execute: async (input) => ({
      tasks: (await deps.taskStore.listTasksByProject(input.projectId, input.limit ?? DEFAULT_TASK_LIMIT)).map(
        taskSummary,
      ),
    }),
  });

  const taskRead = createTool({
    id: 'forgeroom_task_read',
    description: 'Read one task by id. Read-only.',
    inputSchema: z.object({ taskId: z.string() }),
    execute: async (input) => {
      const task = await deps.taskStore.getTask(input.taskId);
      return task === null ? { found: false as const } : { found: true as const, task: taskSummary(task) };
    },
  });

  const taskTimeline = createTool({
    id: 'forgeroom_task_timeline',
    description: 'Step timeline for a task, including OpenClaw session handles (resume hints). Read-only.',
    inputSchema: z.object({ taskId: z.string() }),
    execute: async (input) => ({
      steps: (await deps.taskStore.listSteps(input.taskId)).map((s) => ({
        step_id: s.step_id,
        agent_id: s.agent_id,
        status: s.status,
        check_status: s.check_status,
        started_at: s.started_at.toISOString(),
        finished_at: s.finished_at?.toISOString() ?? null,
        openclaw_session_id: s.openclaw_session_id,
        openclaw_agent_key: s.openclaw_agent_key,
        openclaw_role: s.openclaw_role,
      })),
    }),
  });

  const roomState = createTool({
    id: 'forgeroom_room_state',
    description: 'Project Room live state: config + active tasks. Read-only.',
    inputSchema: z.object({ projectId: z.string() }),
    execute: async (input) => {
      const room = deps.projects.getRoom(input.projectId);
      const active = await deps.taskStore.listActiveTasks(input.projectId);
      return {
        project_id: input.projectId,
        configured: room !== null,
        default_workflow: room?.project.default_workflow ?? null,
        active_tasks: active.map(taskSummary),
      };
    },
  });

  return {
    forgeroom_project_list: projectList,
    forgeroom_project_status: projectStatus,
    forgeroom_task_list: taskList,
    forgeroom_task_read: taskRead,
    forgeroom_task_timeline: taskTimeline,
    forgeroom_room_state: roomState,
  };
}
