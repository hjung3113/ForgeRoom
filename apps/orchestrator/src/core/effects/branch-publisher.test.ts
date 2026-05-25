/**
 * BranchPublisher unit tests (ADR-025, #63). A fake BranchPublishPort records
 * calls so we can assert commit-before-push ordering, no-diff skip behavior,
 * and typed error propagation.
 */
import { describe, expect, it } from 'vitest';

import {
  BranchPublisher,
  BranchPublishFailedError,
  type BranchPublishPort,
  type BranchPublishRequest,
} from './branch-publisher.js';

interface RecordedCalls {
  status: string[];
  commit: Array<{ cwd: string; message: string }>;
  push: Array<{ cwd: string; branch: string; remote?: string }>;
}

interface FakePortOptions {
  statusOutput?: string;
  commitError?: () => Error;
  pushError?: () => Error;
}

function fakePort(options: FakePortOptions = {}): { port: BranchPublishPort; calls: RecordedCalls } {
  const calls: RecordedCalls = { status: [], commit: [], push: [] };
  const port: BranchPublishPort = {
    statusPorcelain: async (cwd: string): Promise<string> => {
      calls.status.push(cwd);
      return options.statusOutput ?? 'M  src/foo.ts\n';
    },
    commit: async (input: { cwd: string; message: string }): Promise<void> => {
      calls.commit.push({ cwd: input.cwd, message: input.message });
      if (options.commitError !== undefined) {
        throw options.commitError();
      }
    },
    push: async (input: { cwd: string; branch: string; remote?: string }): Promise<void> => {
      calls.push.push({ cwd: input.cwd, branch: input.branch, remote: input.remote });
      if (options.pushError !== undefined) {
        throw options.pushError();
      }
    },
  };
  return { port, calls };
}

function request(overrides: Partial<BranchPublishRequest> = {}): BranchPublishRequest {
  return {
    taskId: 'task-1',
    cwd: '/worktrees/task-1',
    branch: 'feat/task-1',
    commitMessage: 'chore: agent output for task-1',
    remote: 'origin',
    ...overrides,
  };
}

describe('BranchPublisher — diff present path', () => {
  it('runs statusPorcelain, then commit, then push in order', async () => {
    const order: string[] = [];
    const { port } = fakePort({ statusOutput: 'M  src/foo.ts\n' });
    const orderedPort: BranchPublishPort = {
      statusPorcelain: async (cwd) => {
        order.push('status');
        return port.statusPorcelain(cwd);
      },
      commit: async (input) => {
        order.push('commit');
        return port.commit(input);
      },
      push: async (input) => {
        order.push('push');
        return port.push(input);
      },
    };
    const publisher = new BranchPublisher({ port: orderedPort });
    const result = await publisher.publish(request());

    expect(result.noDiff).toBe(false);
    expect(order).toEqual(['status', 'commit', 'push']);
  });

  it('passes cwd and branch to commit and push', async () => {
    const { port, calls } = fakePort({ statusOutput: 'A  new-file.ts\n' });
    const publisher = new BranchPublisher({ port });
    await publisher.publish(request({ cwd: '/wt/abc', branch: 'feat/abc', commitMessage: 'chore: abc' }));

    expect(calls.commit[0]).toMatchObject({ cwd: '/wt/abc', message: 'chore: abc' });
    expect(calls.push[0]).toMatchObject({ cwd: '/wt/abc', branch: 'feat/abc', remote: 'origin' });
  });

  it('passes remote when provided', async () => {
    const { port, calls } = fakePort({ statusOutput: 'M  x.ts\n' });
    const publisher = new BranchPublisher({ port });
    await publisher.publish(request({ remote: 'upstream' }));

    expect(calls.push[0]?.remote).toBe('upstream');
  });

  it('omits remote when not provided', async () => {
    const { port, calls } = fakePort({ statusOutput: 'M  x.ts\n' });
    const publisher = new BranchPublisher({ port });
    const req = request();
    delete req.remote;
    await publisher.publish(req);

    expect(calls.push[0]?.remote).toBeUndefined();
  });
});

describe('BranchPublisher — no-diff path', () => {
  it('returns noDiff=true when statusPorcelain is empty, does not commit or push', async () => {
    const { port, calls } = fakePort({ statusOutput: '' });
    const publisher = new BranchPublisher({ port });
    const result = await publisher.publish(request());

    expect(result.noDiff).toBe(true);
    expect(calls.commit).toHaveLength(0);
    expect(calls.push).toHaveLength(0);
  });

  it('treats whitespace-only status as no-diff', async () => {
    const { port, calls } = fakePort({ statusOutput: '  \n  \n' });
    const publisher = new BranchPublisher({ port });
    const result = await publisher.publish(request());

    expect(result.noDiff).toBe(true);
    expect(calls.commit).toHaveLength(0);
  });
});

describe('BranchPublisher — error handling', () => {
  it('throws BranchPublishFailedError with code branch_publish_failed on commit failure', async () => {
    const { port } = fakePort({ commitError: () => new Error('commit denied') });
    const publisher = new BranchPublisher({ port });

    const err = await publisher.publish(request()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BranchPublishFailedError);
    expect((err as BranchPublishFailedError).code).toBe('branch_publish_failed');
    expect((err as BranchPublishFailedError).message).toContain('task-1');
  });

  it('throws BranchPublishFailedError on push failure and does not swallow cause', async () => {
    const cause = new Error('network timeout');
    const { port } = fakePort({ pushError: () => cause });
    const publisher = new BranchPublisher({ port });

    const err = await publisher.publish(request()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BranchPublishFailedError);
    expect((err as BranchPublishFailedError).cause).toBe(cause);
  });

  it('does not push when commit fails', async () => {
    const { port, calls } = fakePort({ commitError: () => new Error('commit denied') });
    const publisher = new BranchPublisher({ port });

    await publisher.publish(request()).catch(() => {});

    expect(calls.push).toHaveLength(0);
  });
});
