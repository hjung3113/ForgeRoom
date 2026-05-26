import type { RuntimeSession } from '../agent-runtime/agent-runner.js';
import type { ProjectRoom } from '../registries/project-registry.js';

/**
 * Intent kind → Project Room OpenClaw role (ADR-028 role-agent table). Drives
 * which `openclaw.agents.<role>` a step runs as. Unknown kinds get no role and
 * therefore no per-run override (the provider keeps its global fallback agent).
 */
const ROLE_BY_KIND: Record<string, string> = {
  write_plan: 'planner',
  refine: 'planner',
  execute: 'implementer',
  review: 'reviewer',
  research: 'researcher',
};

/**
 * Resolve a per-run {@link RuntimeSession} from the project room and the step's
 * intent kind (ADR-028 Project Room seam). Returns `undefined` when the project
 * has no `openclaw` room config or the kind maps to no role — i.e. nothing to
 * override, so the provider uses its global fallback agent.
 *
 * When a room + role resolve, the session always carries `role` and a logical
 * `sessionKey` (`fr:<project>:task:<taskId>:<role>`); `providerAgentId` is set
 * only when the room maps that role to an OpenClaw agent. The sessionKey/role
 * are ForgeRoom-side metadata (OpenClaw has no key flag); persistence is #86.
 */
export function resolveRuntimeSession(
  room: ProjectRoom | null,
  kind: string,
  taskId: string,
): RuntimeSession | undefined {
  if (room?.openclaw === undefined) {
    return undefined;
  }
  const role = ROLE_BY_KIND[kind];
  if (role === undefined) {
    return undefined;
  }

  const session: RuntimeSession = {
    role,
    sessionKey: `fr:${room.project.id}:task:${taskId}:${role}`,
  };
  const providerAgentId = room.openclaw.agents?.[role];
  if (providerAgentId !== undefined) {
    session.providerAgentId = providerAgentId;
  }
  return session;
}
