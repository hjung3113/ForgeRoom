import { describe, expect, it } from 'vitest';

import { resolveRuntimeSession } from './runtime-session.js';
import type { ProjectRoom } from '../registries/project-registry.js';

const projectMeta = {
  id: 'forgeroom',
  path: '/abs/forgeroom',
  default_branch: 'main',
  package_manager: 'pnpm',
  default_workflow: 'full',
  allowed_workflows: ['full'],
  template_dir: null,
  commands: { lint: 'l', typecheck: 't', test: 'x' },
  maintainers: { discord_user_ids: [], github_logins: [] },
};

function room(over: Partial<ProjectRoom> = {}): ProjectRoom {
  return { project: projectMeta, ...over };
}

describe('resolveRuntimeSession (ADR-028)', () => {
  it('returns undefined when the project has no openclaw room config', () => {
    expect(resolveRuntimeSession(room(), 'execute', 'T1')).toBeUndefined();
    expect(resolveRuntimeSession(null, 'execute', 'T1')).toBeUndefined();
  });

  it('returns undefined for an unknown intent kind', () => {
    const r = room({ openclaw: { agents: { implementer: 'fr-impl' } } });
    expect(resolveRuntimeSession(r, 'totally_unknown', 'T1')).toBeUndefined();
  });

  it('maps kind→role and resolves providerAgentId from openclaw.agents', () => {
    const r = room({
      openclaw: { agents: { planner: 'fr-planner', implementer: 'fr-impl', reviewer: 'fr-rev' } },
    });
    expect(resolveRuntimeSession(r, 'execute', 'T1')).toEqual({
      role: 'implementer',
      providerAgentId: 'fr-impl',
      sessionKey: 'fr:forgeroom:task:T1:implementer',
    });
    expect(resolveRuntimeSession(r, 'write_plan', 'T1')?.role).toBe('planner');
    expect(resolveRuntimeSession(r, 'refine', 'T1')?.role).toBe('planner');
    expect(resolveRuntimeSession(r, 'review', 'T1')?.providerAgentId).toBe('fr-rev');
  });

  it('still carries role + sessionKey when the room maps no agent for that role', () => {
    const r = room({ openclaw: { room: 'forgeroom', agents: { planner: 'fr-planner' } } });
    expect(resolveRuntimeSession(r, 'execute', 'T9')).toEqual({
      role: 'implementer',
      sessionKey: 'fr:forgeroom:task:T9:implementer',
    });
  });

  it('handles an openclaw section with no agents map', () => {
    const r = room({ openclaw: { room: 'forgeroom' } });
    const s = resolveRuntimeSession(r, 'research', 'T2');
    expect(s).toEqual({ role: 'researcher', sessionKey: 'fr:forgeroom:task:T2:researcher' });
  });
});
