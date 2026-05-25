/**
 * IssueLabelLifecycleEffect unit tests (ADR-026, #64).
 *
 * A fake IssueLabelPort records calls. Covers:
 *  - done  → removeLabel(ready-for-agent) + addLabel(ready-for-human)
 *  - failed → removeLabel(ready-for-agent) + addLabel(needs-info)
 *  - no-op when source is discord-command
 *  - no-op when issue_number is null
 *  - label-client failure is caught and does NOT propagate
 */
import { describe, expect, it } from 'vitest';

import type { Task } from '../types.js';
import {
  IssueLabelLifecycleEffect,
  type IssueLabelPort,
  type LabelLifecycleRequest,
} from './issue-label-lifecycle.js';

// ---------------------------------------------------------------------------
// Fake port
// ---------------------------------------------------------------------------

interface Recorded {
  add: Array<{ owner: string; repo: string; issue_number: number; labels: string[] }>;
  remove: Array<{ owner: string; repo: string; issue_number: number; name: string }>;
}

interface FakePortOptions {
  /** If set, throw this error on every call. */
  error?: Error;
}

function fakePort(options: FakePortOptions = {}): { port: IssueLabelPort; calls: Recorded } {
  const calls: Recorded = { add: [], remove: [] };
  const port: IssueLabelPort = {
    addLabel: async (args) => {
      if (options.error !== undefined) {
        throw options.error;
      }
      calls.add.push(args);
    },
    removeLabel: async (args) => {
      if (options.error !== undefined) {
        throw options.error;
      }
      calls.remove.push(args);
    },
  };
  return { port, calls };
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function issueLabelRequest(overrides: Partial<LabelLifecycleRequest> = {}): LabelLifecycleRequest {
  return {
    task: {
      id: 'task-1',
      source: 'github-issue-label',
      issue_number: 42,
    } as Task,
    terminalStatus: 'done',
    owner: 'acme',
    repo: 'widget',
    ...overrides,
  };
}

function discordRequest(terminalStatus: 'done' | 'failed' = 'done'): LabelLifecycleRequest {
  return issueLabelRequest({
    task: {
      id: 'task-d',
      source: 'discord-command',
      issue_number: null,
    } as unknown as Task,
    terminalStatus,
  });
}

function nullIssueRequest(): LabelLifecycleRequest {
  return issueLabelRequest({
    task: {
      id: 'task-n',
      source: 'github-issue-label',
      issue_number: null,
    } as unknown as Task,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IssueLabelLifecycleEffect — done → ready-for-human', () => {
  it('removes ready-for-agent and adds ready-for-human on done', async () => {
    const { port, calls } = fakePort();
    const effect = new IssueLabelLifecycleEffect({ port, log: () => {} });

    await effect.apply(issueLabelRequest({ terminalStatus: 'done' }));

    expect(calls.remove).toHaveLength(1);
    expect(calls.remove[0]).toMatchObject({
      owner: 'acme',
      repo: 'widget',
      issue_number: 42,
      name: 'ready-for-agent',
    });
    expect(calls.add).toHaveLength(1);
    expect(calls.add[0]).toMatchObject({
      owner: 'acme',
      repo: 'widget',
      issue_number: 42,
      labels: ['ready-for-human'],
    });
  });
});

describe('IssueLabelLifecycleEffect — failed → needs-info', () => {
  it('removes ready-for-agent and adds needs-info on failed', async () => {
    const { port, calls } = fakePort();
    const effect = new IssueLabelLifecycleEffect({ port, log: () => {} });

    await effect.apply(issueLabelRequest({ terminalStatus: 'failed' }));

    expect(calls.remove).toHaveLength(1);
    expect(calls.remove[0]).toMatchObject({ name: 'ready-for-agent' });
    expect(calls.add).toHaveLength(1);
    expect(calls.add[0]).toMatchObject({ labels: ['needs-info'] });
  });
});

describe('IssueLabelLifecycleEffect — no-op paths', () => {
  it('is a no-op when source is discord-command (issue_number irrelevant)', async () => {
    const { port, calls } = fakePort();
    const effect = new IssueLabelLifecycleEffect({ port, log: () => {} });

    await effect.apply(discordRequest('done'));

    expect(calls.add).toHaveLength(0);
    expect(calls.remove).toHaveLength(0);
  });

  it('is a no-op when source is discord-command and status is failed', async () => {
    const { port, calls } = fakePort();
    const effect = new IssueLabelLifecycleEffect({ port, log: () => {} });

    await effect.apply(discordRequest('failed'));

    expect(calls.add).toHaveLength(0);
    expect(calls.remove).toHaveLength(0);
  });

  it('is a no-op when source is github-issue-label but issue_number is null', async () => {
    const { port, calls } = fakePort();
    const effect = new IssueLabelLifecycleEffect({ port, log: () => {} });

    await effect.apply(nullIssueRequest());

    expect(calls.add).toHaveLength(0);
    expect(calls.remove).toHaveLength(0);
  });
});

describe('IssueLabelLifecycleEffect — failure isolation', () => {
  it('does not throw when the label port throws during removeLabel', async () => {
    const { port } = fakePort({ error: new Error('GitHub 422') });
    const effect = new IssueLabelLifecycleEffect({ port, log: () => {} });

    await expect(
      effect.apply(issueLabelRequest({ terminalStatus: 'done' })),
    ).resolves.toBeUndefined();
  });

  it('does not throw when the label port throws during addLabel', async () => {
    // Make removeLabel succeed but addLabel fail by using a custom port.
    const calls: Recorded = { add: [], remove: [] };
    const partialFailPort: IssueLabelPort = {
      removeLabel: async (args) => {
        calls.remove.push(args);
      },
      addLabel: async () => {
        throw new Error('rate-limited');
      },
    };
    const effect = new IssueLabelLifecycleEffect({ port: partialFailPort, log: () => {} });

    await expect(
      effect.apply(issueLabelRequest({ terminalStatus: 'done' })),
    ).resolves.toBeUndefined();
    // removeLabel ran (before the addLabel failure was encountered)
    expect(calls.remove).toHaveLength(1);
  });
});
