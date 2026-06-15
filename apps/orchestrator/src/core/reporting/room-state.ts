/**
 * Project Room read-model (Phase 2D Canvas dashboard, roadmap-v3).
 *
 * `buildRoomState` snapshots a Project Room into a serializable object the
 * Canvas dashboard renders. It is a NON-AUTHORITATIVE mirror (ADR-028 §5):
 * derived purely from the authoritative TaskStore/ProjectRegistry, never the
 * source of truth. Nothing reads it back to drive task control flow.
 */
import type { ProjectRegistry } from '../registries/project-registry.js';
import type { TaskStore } from '../task-store.js';
import type { Task, Step } from '../types.js';

export interface RoomStateDeps {
  projects: Pick<ProjectRegistry, 'getRoom'>;
  taskStore: Pick<TaskStore, 'listActiveTasks' | 'listTasksByProject' | 'listSteps'>;
}

export interface RoomStateTask {
  id: string;
  title: string;
  status: string;
  workflow_id: string;
  pr_number: number | null;
  active_step: string | null;
}

export interface RoomStateSession {
  task_id: string;
  step_id: string;
  role: string | null;
  agent_key: string | null;
  session_id: string | null;
}

export interface RoomState {
  project_id: string;
  generated_at: string;
  configured: boolean;
  default_workflow: string | null;
  allowed_workflows: string[];
  active_tasks: RoomStateTask[];
  recent_tasks: RoomStateTask[];
  sessions: RoomStateSession[];
}

const RECENT_TASK_LIMIT = 15;

function latestActiveStep(steps: Step[]): string | null {
  const running = steps.filter((s) => s.status === 'running');
  const pick = running.at(-1) ?? steps.at(-1);
  return pick?.step_id ?? null;
}

export async function buildRoomState(
  deps: RoomStateDeps,
  projectId: string,
  now: () => Date = () => new Date(),
): Promise<RoomState> {
  const room = deps.projects.getRoom(projectId);
  const active = await deps.taskStore.listActiveTasks(projectId);
  const recent = await deps.taskStore.listTasksByProject(projectId, RECENT_TASK_LIMIT);

  const sessions: RoomStateSession[] = [];
  const activeTasks: RoomStateTask[] = [];
  for (const task of active) {
    const steps = await deps.taskStore.listSteps(task.id);
    activeTasks.push(toRoomTask(task, latestActiveStep(steps)));
    for (const s of steps) {
      if (s.openclaw_session_id !== null || s.openclaw_role !== null) {
        sessions.push({
          task_id: task.id,
          step_id: s.step_id,
          role: s.openclaw_role,
          agent_key: s.openclaw_agent_key,
          session_id: s.openclaw_session_id,
        });
      }
    }
  }

  return {
    project_id: projectId,
    generated_at: now().toISOString(),
    configured: room !== null,
    default_workflow: room?.project.default_workflow ?? null,
    allowed_workflows: room?.project.allowed_workflows ?? [],
    active_tasks: activeTasks,
    recent_tasks: recent.map((t) => toRoomTask(t, null)),
    sessions,
  };
}

function toRoomTask(task: Task, activeStep: string | null): RoomStateTask {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    workflow_id: task.workflow_id,
    pr_number: task.pr_number,
    active_step: activeStep,
  };
}
