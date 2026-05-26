import type { TaskRequest } from '../../core/types.js';
import type {
  GitHubGatewayLogger,
  GitHubIssue,
  GitHubOctokitLike,
  GitHubRepoPoll,
  OctokitResolver,
} from './types.js';

const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

interface HttpishError {
  status?: number;
  response?: { headers?: Record<string, string | undefined> };
}

/**
 * Transient = worth retrying on the next (backed-off) poll. Network errors
 * (no `status`) and 5xx/429 are transient. A 403 is only transient when GitHub
 * reports the rate limit is exhausted (`x-ratelimit-remaining: 0`); a plain
 * 403/401/404 is a configuration/permission problem and is NOT retried.
 */
export function isTransientGitHubError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const status = (error as HttpishError).status;
  if (typeof status !== 'number') {
    // No HTTP status — treat as a network/transport error.
    return true;
  }
  if (TRANSIENT_STATUSES.has(status)) {
    return true;
  }
  if (status === 403) {
    const remaining = (error as HttpishError).response?.headers?.['x-ratelimit-remaining'];
    return remaining === '0';
  }
  return false;
}

export interface GitHubIssueTaskSourceOptions {
  octokit: OctokitResolver;
  repos: GitHubRepoPoll[];
  onTask: (request: TaskRequest) => Promise<void>;
  logger: GitHubGatewayLogger;
  /** Base poll interval in ms (default 60_000). */
  intervalMs?: number;
  /** Backoff base in ms (default 1_000). */
  backoffBaseMs?: number;
  /** Backoff cap in ms (default 60_000). */
  backoffCapMs?: number;
  /**
   * Issue numbers already dispatched, keyed by `${owner}/${repo}`. Lets a
   * composition root seed dedup state on restart without the gateway touching
   * the DB (forbidden in this layer).
   */
  seen?: Record<string, number[]>;
}

const DEFAULT_LABEL = 'agent';
const WORKFLOW_LABEL_PREFIX = 'workflow:';
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BACKOFF_CAP_MS = 60_000;

export class GitHubIssueTaskSource {
  private readonly resolveOctokit: (repo: GitHubRepoPoll) => GitHubOctokitLike;
  private readonly repos: GitHubRepoPoll[];
  private readonly onTask: (request: TaskRequest) => Promise<void>;
  private readonly logger: GitHubGatewayLogger;
  private readonly intervalMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly seen = new Map<string, Set<number>>();

  private stopped = true;
  private consecutiveFailures = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: GitHubIssueTaskSourceOptions) {
    const octokit = options.octokit;
    this.resolveOctokit = typeof octokit === 'function' ? octokit : () => octokit;
    this.repos = options.repos;
    this.onTask = options.onTask;
    this.logger = options.logger;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.backoffCapMs = options.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;

    for (const [key, numbers] of Object.entries(options.seen ?? {})) {
      this.seen.set(key, new Set(numbers));
    }
  }

  /** Start the self-rescheduling poll loop. Idempotent. */
  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.scheduleNext(0);
  }

  /** Stop the poll loop and clear any pending timer. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Poll every repo once. A failure on one repo is logged and swallowed so the
   * other repos still get polled and the loop survives. Throws nothing.
   * Returns whether every repo poll succeeded (drives backoff in `start()`).
   */
  async pollOnce(): Promise<void> {
    await this.pollAll();
  }

  private async pollAll(): Promise<boolean> {
    let allOk = true;
    for (const repo of this.repos) {
      try {
        await this.pollRepo(repo);
      } catch (error) {
        allOk = false;
        const transient = isTransientGitHubError(error);
        const message = `github poll failed for ${repo.owner}/${repo.repo} (transient=${transient}): ${describe(error)}`;
        if (transient) {
          this.logger.warn(message);
        } else {
          this.logger.error(message);
        }
      }
    }
    return allOk;
  }

  private async pollRepo(repo: GitHubRepoPoll): Promise<void> {
    const label = repo.label ?? DEFAULT_LABEL;
    const octokit = this.resolveOctokit(repo);
    const { data } = await octokit.rest.issues.listForRepo({
      owner: repo.owner,
      repo: repo.repo,
      labels: label,
      state: 'open',
      per_page: 100,
    });

    const seen = this.seenSet(repo);
    for (const issue of data) {
      if (issue.pull_request) {
        continue; // The issues endpoint also returns PRs; skip them.
      }
      if (!hasLabel(issue, label)) {
        continue;
      }
      if (seen.has(issue.number)) {
        continue;
      }
      seen.add(issue.number);
      const workflowId = this.resolveWorkflowLabel(repo, issue);
      await this.onTask(toTaskRequest(repo, issue, workflowId));
    }
  }

  /**
   * Optional per-issue workflow override via a `workflow:<id>` label (ADR-028
   * self-improvement runs). Exactly one such label sets `workflowId`; zero or
   * an ambiguous multiple falls back to the project default (the core engine
   * still validates the id against `allowed_workflows`).
   */
  private resolveWorkflowLabel(repo: GitHubRepoPoll, issue: GitHubIssue): string | undefined {
    const ids = new Set<string>();
    for (const entry of issue.labels) {
      const name = typeof entry === 'string' ? entry : entry.name;
      if (name.startsWith(WORKFLOW_LABEL_PREFIX)) {
        ids.add(name.slice(WORKFLOW_LABEL_PREFIX.length));
      }
    }
    if (ids.size === 0) {
      return undefined;
    }
    if (ids.size > 1) {
      this.logger.warn(
        `${repo.owner}/${repo.repo}#${issue.number}: multiple workflow:<id> labels are ambiguous (${[...ids].join(', ')}); using project default`,
      );
      return undefined;
    }
    return [...ids][0];
  }

  private seenSet(repo: GitHubRepoPoll): Set<number> {
    const key = `${repo.owner}/${repo.repo}`;
    let set = this.seen.get(key);
    if (set === undefined) {
      set = new Set<number>();
      this.seen.set(key, set);
    }
    return set;
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped) {
      return;
    }
    const allOk = await this.pollAll();
    if (allOk) {
      this.consecutiveFailures = 0;
      this.scheduleNext(this.intervalMs);
    } else {
      this.consecutiveFailures += 1;
      this.scheduleNext(this.backoffDelay());
    }
  }

  private backoffDelay(): number {
    // 1 failure -> base*2, 2 -> base*4, ... capped. Always exceeds the normal
    // interval so a transient blip widens the retry gap rather than hot-looping.
    return Math.min(this.backoffBaseMs * 2 ** this.consecutiveFailures, this.backoffCapMs);
  }
}

function hasLabel(issue: GitHubIssue, label: string): boolean {
  return issue.labels.some((entry) =>
    typeof entry === 'string' ? entry === label : entry.name === label,
  );
}

function toTaskRequest(
  repo: GitHubRepoPoll,
  issue: GitHubIssue,
  workflowId: string | undefined,
): TaskRequest {
  return {
    projectId: repo.projectId,
    title: issue.title,
    description: issue.body ?? '',
    source: 'github-issue-label',
    workflowId,
    externalRef: {
      provider: 'github',
      id: String(issue.number),
      url: issue.html_url,
      title: issue.title,
    },
    issueNumber: issue.number,
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
