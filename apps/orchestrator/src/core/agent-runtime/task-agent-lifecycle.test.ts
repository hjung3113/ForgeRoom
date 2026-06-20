import { describe, expect, it } from 'vitest';

import { ephemeralAgentIdForTask } from './task-agent-lifecycle.js';

describe('ephemeralAgentIdForTask', () => {
  it('derives a deterministic per-task OpenClaw agent id from the task id', () => {
    const id = '698d1d87-e049-4db6-b61a-64b999f4129e';
    expect(ephemeralAgentIdForTask(id)).toBe('fr-698d1d87-e049-4db6-b61a-64b999f4129e');
  });

  it('is stable across calls (so retries/resume never leak to the global agent)', () => {
    expect(ephemeralAgentIdForTask('abc')).toBe(ephemeralAgentIdForTask('abc'));
  });

  it('namespaces every task under the fr- prefix so orphan GC can match them', () => {
    expect(ephemeralAgentIdForTask('abc').startsWith('fr-')).toBe(true);
  });
});
