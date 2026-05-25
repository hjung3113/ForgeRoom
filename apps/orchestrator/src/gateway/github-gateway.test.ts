import { describe, expect, it, vi } from 'vitest';

import {
  GitHubIssueTaskSource,
  GitHubIssueLabelClient,
  GitHubPullRequestClient,
  isTransientGitHubError,
  type GitHubIssue,
  type GitHubOctokitLike,
  type GitHubRepoPoll,
} from './github-gateway.js';
import type { TaskRequest } from '../core/types.js';

class RequestErrorLike extends Error {
  constructor(
    readonly status: number,
    readonly response?: { headers?: Record<string, string> },
  ) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
  }
}

function issue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: 1,
    title: 'Add login',
    body: 'Please add login',
    html_url: 'https://github.com/acme/app/issues/1',
    labels: [{ name: 'agent' }],
    pull_request: undefined,
    ...overrides,
  };
}

function fakeOctokit(issuesByPage: GitHubIssue[]): GitHubOctokitLike {
  return {
    rest: {
      issues: {
        listForRepo: vi.fn(async () => ({ data: issuesByPage })),
        addLabels: vi.fn(async () => ({})),
        removeLabel: vi.fn(async () => ({})),
      },
      pulls: {
        create: vi.fn(async () => ({
          data: { number: 7, html_url: 'https://github.com/acme/app/pull/7' },
        })),
        update: vi.fn(async () => ({
          data: { number: 7, html_url: 'https://github.com/acme/app/pull/7' },
        })),
        list: vi.fn(async () => ({ data: [] })),
      },
    },
  };
}

const repo: GitHubRepoPoll = {
  projectId: 'app',
  owner: 'acme',
  repo: 'app',
  label: 'agent',
};

const silentLogger = { warn: () => {}, error: () => {} };

describe('GitHubIssueTaskSource', () => {
  describe('pollOnce', () => {
    it('builds a TaskRequest from a labeled issue', async () => {
      const requests: TaskRequest[] = [];
      const source = new GitHubIssueTaskSource({
        octokit: fakeOctokit([issue()]),
        repos: [repo],
        onTask: async (req) => {
          requests.push(req);
        },
        logger: silentLogger,
      });

      await source.pollOnce();

      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        projectId: 'app',
        title: 'Add login',
        description: 'Please add login',
        source: 'github-issue-label',
        issueNumber: 1,
        externalRef: {
          provider: 'github',
          id: '1',
          url: 'https://github.com/acme/app/issues/1',
          title: 'Add login',
        },
      });
    });

    it('does not dispatch the same issue twice across poll ticks', async () => {
      const requests: TaskRequest[] = [];
      const source = new GitHubIssueTaskSource({
        octokit: fakeOctokit([issue()]),
        repos: [repo],
        onTask: async (req) => {
          requests.push(req);
        },
        logger: silentLogger,
      });

      await source.pollOnce();
      await source.pollOnce();

      expect(requests).toHaveLength(1);
    });

    it('skips pull requests returned by the issues endpoint', async () => {
      const requests: TaskRequest[] = [];
      const source = new GitHubIssueTaskSource({
        octokit: fakeOctokit([issue({ pull_request: { url: 'x' } })]),
        repos: [repo],
        onTask: async (req) => {
          requests.push(req);
        },
        logger: silentLogger,
      });

      await source.pollOnce();

      expect(requests).toHaveLength(0);
    });

    it('does not crash when one repo poll fails and still polls the others', async () => {
      const failing: GitHubOctokitLike = {
        rest: {
          issues: {
            listForRepo: vi.fn(async () => {
              throw new RequestErrorLike(503);
            }),
          },
          pulls: fakeOctokit([]).rest.pulls,
        },
      };
      const ok = fakeOctokit([issue({ number: 2 })]);
      // Route per-repo octokit via a resolver.
      const requests: TaskRequest[] = [];
      const warnings: string[] = [];
      const source = new GitHubIssueTaskSource({
        octokit: (r) => (r.repo === 'broken' ? failing : ok),
        repos: [
          { projectId: 'broken', owner: 'acme', repo: 'broken', label: 'agent' },
          repo,
        ],
        onTask: async (req) => {
          requests.push(req);
        },
        logger: { warn: (m) => warnings.push(m), error: () => {} },
      });

      await expect(source.pollOnce()).resolves.toBeUndefined();
      expect(requests).toHaveLength(1);
      expect(requests[0]?.issueNumber).toBe(2);
      expect(warnings.length).toBeGreaterThan(0);
    });
  });

  describe('start/stop backoff', () => {
    it('extends the delay after a transient failure and recovers', async () => {
      vi.useFakeTimers();
      try {
        let attempt = 0;
        const octokit: GitHubOctokitLike = {
          rest: {
            issues: {
              listForRepo: vi.fn(async () => {
                attempt += 1;
                if (attempt === 1) throw new RequestErrorLike(503);
                return { data: [issue()] };
              }),
            },
            pulls: fakeOctokit([]).rest.pulls,
          },
        };
        const requests: TaskRequest[] = [];
        const source = new GitHubIssueTaskSource({
          octokit,
          repos: [repo],
          onTask: async (req) => {
            requests.push(req);
          },
          intervalMs: 1000,
          backoffBaseMs: 1000,
          backoffCapMs: 60_000,
          logger: silentLogger,
        });

        source.start();
        // First tick fails (transient) -> backoff doubles next delay.
        await vi.advanceTimersByTimeAsync(0);
        expect(requests).toHaveLength(0);
        // Normal interval (1000ms) should NOT yet retry because backoff is 2000ms.
        await vi.advanceTimersByTimeAsync(1000);
        expect(requests).toHaveLength(0);
        // After full backoff window the poll succeeds.
        await vi.advanceTimersByTimeAsync(1000);
        expect(requests).toHaveLength(1);

        source.stop();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe('isTransientGitHubError', () => {
  it('treats 5xx and 429 as transient', () => {
    expect(isTransientGitHubError(new RequestErrorLike(503))).toBe(true);
    expect(isTransientGitHubError(new RequestErrorLike(500))).toBe(true);
    expect(isTransientGitHubError(new RequestErrorLike(429))).toBe(true);
  });

  it('treats network errors (no status) as transient', () => {
    expect(isTransientGitHubError(new Error('ECONNRESET'))).toBe(true);
  });

  it('treats 401/404 as non-transient', () => {
    expect(isTransientGitHubError(new RequestErrorLike(401))).toBe(false);
    expect(isTransientGitHubError(new RequestErrorLike(404))).toBe(false);
  });

  it('treats 403 with exhausted rate limit as transient', () => {
    const err = new RequestErrorLike(403, { headers: { 'x-ratelimit-remaining': '0' } });
    expect(isTransientGitHubError(err)).toBe(true);
  });

  it('treats a plain 403 (forbidden) as non-transient', () => {
    expect(isTransientGitHubError(new RequestErrorLike(403))).toBe(false);
  });
});

describe('GitHubPullRequestClient', () => {
  it('createPR is a thin pulls.create call returning a PRRef', async () => {
    const octokit = fakeOctokit([]);
    const client = new GitHubPullRequestClient(octokit);

    const ref = await client.createPR({
      owner: 'acme',
      repo: 'app',
      title: 'feat: login',
      body: 'body',
      head: 'feat/login',
      base: 'main',
    });

    expect(ref).toEqual({ number: 7, url: 'https://github.com/acme/app/pull/7' });
    expect(octokit.rest.pulls.create).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'app',
      title: 'feat: login',
      body: 'body',
      head: 'feat/login',
      base: 'main',
    });
  });

  it('updatePR is a thin pulls.update call', async () => {
    const octokit = fakeOctokit([]);
    const client = new GitHubPullRequestClient(octokit);

    await client.updatePR({ owner: 'acme', repo: 'app', pull_number: 7, body: 'new body' });

    expect(octokit.rest.pulls.update).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'app',
      pull_number: 7,
      body: 'new body',
    });
  });

  it('findOpenPRByHead returns the first matching open PR or null', async () => {
    const octokit = fakeOctokit([]);
    octokit.rest.pulls.list = vi.fn(async () => ({
      data: [{ number: 9, html_url: 'https://github.com/acme/app/pull/9' }],
    }));
    const client = new GitHubPullRequestClient(octokit);

    const ref = await client.findOpenPRByHead({ owner: 'acme', repo: 'app', head: 'feat/login' });

    expect(ref).toEqual({ number: 9, url: 'https://github.com/acme/app/pull/9' });
    expect(octokit.rest.pulls.list).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'app',
      head: 'acme:feat/login',
      state: 'open',
    });
  });

  it('findOpenPRByHead returns null when there is no match', async () => {
    const octokit = fakeOctokit([]);
    const client = new GitHubPullRequestClient(octokit);

    const ref = await client.findOpenPRByHead({ owner: 'acme', repo: 'app', head: 'feat/login' });

    expect(ref).toBeNull();
  });
});

describe('GitHubIssueLabelClient', () => {
  it('addLabel is a thin issues.addLabels call', async () => {
    const octokit = fakeOctokit([]);
    const client = new GitHubIssueLabelClient(octokit);

    await client.addLabel({
      owner: 'acme',
      repo: 'app',
      issue_number: 42,
      labels: ['ready-for-human'],
    });

    expect(octokit.rest.issues.addLabels).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'app',
      issue_number: 42,
      labels: ['ready-for-human'],
    });
  });

  it('removeLabel is a thin issues.removeLabel call', async () => {
    const octokit = fakeOctokit([]);
    const client = new GitHubIssueLabelClient(octokit);

    await client.removeLabel({
      owner: 'acme',
      repo: 'app',
      issue_number: 42,
      name: 'ready-for-agent',
    });

    expect(octokit.rest.issues.removeLabel).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'app',
      issue_number: 42,
      name: 'ready-for-agent',
    });
  });
});
