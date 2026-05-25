/**
 * PullRequestCreator unit tests (ADR-019, #29). A fake PullRequestClient records
 * calls so we can assert discovery-before-create, never-double-create, retry
 * with exhaustion, and the task marker.
 */
import { describe, expect, it } from 'vitest';

import {
  PullRequestCreator,
  PullRequestCreateFailedError,
  NonRetryablePullRequestError,
  taskMarker,
  withTaskMarker,
  type CreatePullRequestArgs,
  type FindOpenPullRequestArgs,
  type PullRequestClient,
  type PullRequestEffectRequest,
  type PullRequestRef,
  type UpdatePullRequestArgs,
} from './pull-request-creator.js';

interface Recorded {
  create: CreatePullRequestArgs[];
  update: UpdatePullRequestArgs[];
  find: FindOpenPullRequestArgs[];
}

interface FakeOptions {
  findResult?: PullRequestRef | null;
  createResult?: PullRequestRef;
  /** Throw on the first N create calls (then succeed). */
  createFailures?: number;
  createError?: () => unknown;
}

function fakeClient(options: FakeOptions = {}): { client: PullRequestClient; calls: Recorded } {
  const calls: Recorded = { create: [], update: [], find: [] };
  let createCount = 0;
  const client: PullRequestClient = {
    createPR: async (args) => {
      calls.create.push(args);
      createCount += 1;
      if (options.createFailures !== undefined && createCount <= options.createFailures) {
        throw options.createError ? options.createError() : new Error(`boom-${createCount}`);
      }
      return options.createResult ?? { number: 100, url: 'https://gh/pull/100' };
    },
    updatePR: async (args) => {
      calls.update.push(args);
    },
    findOpenPRByHead: async (args) => {
      calls.find.push(args);
      return options.findResult ?? null;
    },
  };
  return { client, calls };
}

function request(overrides: Partial<PullRequestEffectRequest> = {}): PullRequestEffectRequest {
  return {
    taskId: 'task-1',
    prNumber: null,
    owner: 'acme',
    repo: 'widget',
    head: 'feat/task-1',
    base: 'main',
    title: 'feat: do thing',
    body: 'Summary of the change.',
    draft: true,
    ...overrides,
  };
}

const noSleep = async (): Promise<void> => Promise.resolve();

describe('withTaskMarker', () => {
  it('appends the task marker once and is idempotent', () => {
    const once = withTaskMarker('body', 'task-9');
    expect(once).toContain(taskMarker('task-9'));
    expect(withTaskMarker(once, 'task-9')).toBe(once);
  });
});

describe('PullRequestCreator discovery-before-create', () => {
  it('creates a PR when no existing PR is found and embeds the marker', async () => {
    const { client, calls } = fakeClient({ createResult: { number: 7, url: 'u7' } });
    const creator = new PullRequestCreator({ client, sleep: noSleep });

    const result = await creator.ensure(request());

    expect(result).toEqual({ ref: { number: 7, url: 'u7' }, via: 'created' });
    expect(calls.find).toHaveLength(1);
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0]?.body).toContain(taskMarker('task-1'));
    expect(calls.create[0]?.draft).toBe(true);
  });

  it('reuses an existing PR by pr_number without creating', async () => {
    const { client, calls } = fakeClient();
    const creator = new PullRequestCreator({ client, sleep: noSleep });

    const result = await creator.ensure(request({ prNumber: 42 }));

    expect(result.via).toBe('reused_by_number');
    expect(result.ref.number).toBe(42);
    expect(calls.update).toHaveLength(1);
    expect(calls.find).toHaveLength(0);
    expect(calls.create).toHaveLength(0);
  });

  it('reuses an existing open PR discovered by head, never double-creating', async () => {
    const { client, calls } = fakeClient({ findResult: { number: 55, url: 'u55' } });
    const creator = new PullRequestCreator({ client, sleep: noSleep });

    const result = await creator.ensure(request());

    expect(result).toEqual({ ref: { number: 55, url: 'u55' }, via: 'reused_by_head' });
    expect(calls.find).toHaveLength(1);
    expect(calls.create).toHaveLength(0);
  });
});

describe('PullRequestCreator retry', () => {
  it('retries with backoff and succeeds before exhaustion', async () => {
    const slept: number[] = [];
    const { client, calls } = fakeClient({ createFailures: 2, createResult: { number: 9, url: 'u9' } });
    const creator = new PullRequestCreator({
      client,
      backoffBaseMs: 10,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    const result = await creator.ensure(request());

    expect(result.ref.number).toBe(9);
    expect(calls.create).toHaveLength(3);
    // Two backoff waits between three attempts: 10 * 2^0, 10 * 2^1.
    expect(slept).toEqual([10, 20]);
  });

  it('throws pr_create_failed after 3 failed attempts', async () => {
    const { client, calls } = fakeClient({ createFailures: 99 });
    const creator = new PullRequestCreator({ client, sleep: noSleep });

    const error = await creator.ensure(request()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PullRequestCreateFailedError);
    expect((error as PullRequestCreateFailedError).code).toBe('pr_create_failed');
    expect((error as PullRequestCreateFailedError).attempts).toBe(3);
    expect(calls.create).toHaveLength(3);
  });

  it('does not retry a non-retryable error', async () => {
    const { client, calls } = fakeClient({
      createFailures: 99,
      createError: () => new NonRetryablePullRequestError('422 validation'),
    });
    const creator = new PullRequestCreator({ client, sleep: noSleep });

    await expect(creator.ensure(request())).rejects.toBeInstanceOf(PullRequestCreateFailedError);
    expect(calls.create).toHaveLength(1);
  });

  it('restarts each retry from discovery (no blind create after ambiguous failure)', async () => {
    // First attempt: find returns null, create throws (ambiguous). Second
    // attempt: find now returns the PR that the ambiguous create actually made.
    const calls: Recorded = { create: [], update: [], find: [] };
    let findCount = 0;
    let createCount = 0;
    const client: PullRequestClient = {
      findOpenPRByHead: async (args) => {
        calls.find.push(args);
        findCount += 1;
        return findCount === 1 ? null : { number: 200, url: 'u200' };
      },
      createPR: async (args) => {
        calls.create.push(args);
        createCount += 1;
        throw new Error('timeout after create');
      },
      updatePR: async (args) => {
        calls.update.push(args);
      },
    };
    const creator = new PullRequestCreator({ client, sleep: noSleep });

    const result = await creator.ensure(request());

    expect(result).toEqual({ ref: { number: 200, url: 'u200' }, via: 'reused_by_head' });
    expect(createCount).toBe(1); // only the first ambiguous attempt created
    expect(calls.find).toHaveLength(2);
  });
});
