/**
 * PullRequestCreator — workflow external effect (ADR-019).
 *
 * The PipelineEngine invokes this AFTER a workflow/check run succeeds and BEFORE
 * marking the task `done`, but only when the workflow's `effects.external.pr` is
 * not `none`. PR creation is a TASK-CRITICAL external effect (not best-effort
 * Reporter delivery): a final failure fails the task with
 * `failure_reason=pr_create_failed`.
 *
 * Contract (ADR-019):
 *   - retry: up to {@link PULL_REQUEST_CREATE_MAX_ATTEMPTS} attempts, exponential
 *     backoff between them.
 *   - idempotency key: `task.id + branch_name` (the natural key for the open PR).
 *   - discovery-before-create: every attempt restarts from discovery so an
 *     ambiguous create timeout never blind-creates a duplicate —
 *       1. `task.pr_number` set -> update body/title, return.
 *       2. else `findOpenPRByHead(head)` -> if found, return (engine persists
 *          pr_number).
 *       3. else create.
 *   - the body always carries the marker `<!-- forgeroom:task_id=<id> -->` so a
 *     human or a later discovery can correlate the PR with its task.
 *
 * Core stays gateway-free: this depends on the injected {@link PullRequestClient}
 * interface (shape matches the gateway `GitHubPullRequestClient`); the concrete
 * Octokit-backed impl is wired at the composition root (#30).
 */
import { OrchestratorError } from '../errors.js';

// ---------------------------------------------------------------------------
// Injected primitive (gateway-free seam; matches GitHubPullRequestClient shape)
// ---------------------------------------------------------------------------

export interface PullRequestRef {
  number: number;
  url: string;
}

export interface CreatePullRequestArgs {
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
  draft?: boolean;
}

export interface UpdatePullRequestArgs {
  owner: string;
  repo: string;
  pull_number: number;
  body?: string;
  title?: string;
}

export interface FindOpenPullRequestArgs {
  owner: string;
  repo: string;
  /** Branch name (without the `owner:` qualifier). */
  head: string;
}

/**
 * Thin PR API primitive the creator orchestrates. Each method is a single API
 * call with no retry/idempotency of its own (that lives here). Matches the
 * gateway `GitHubPullRequestClient` structurally so a fake or the real client
 * both satisfy it without a gateway import in core.
 */
export interface PullRequestClient {
  createPR(args: CreatePullRequestArgs): Promise<PullRequestRef>;
  updatePR(args: UpdatePullRequestArgs): Promise<void>;
  findOpenPRByHead(args: FindOpenPullRequestArgs): Promise<PullRequestRef | null>;
}

// ---------------------------------------------------------------------------
// Request / result
// ---------------------------------------------------------------------------

/**
 * Everything the creator needs for one task's PR effect. The engine resolves the
 * GitHub coordinates (owner/repo/base) from a composition-root resolver; core
 * never derives them itself.
 */
export interface PullRequestEffectRequest {
  taskId: string;
  /** Existing PR number persisted on the task, or null on the first attempt. */
  prNumber: number | null;
  owner: string;
  repo: string;
  /** Branch the agent pushed (the PR head). Part of the idempotency key. */
  head: string;
  /** Target branch for the PR. */
  base: string;
  title: string;
  /** Body WITHOUT the marker; the creator appends the task marker. */
  body: string;
  /** `draft` PR when the workflow effect is `draft`, otherwise a ready PR. */
  draft: boolean;
}

export interface PullRequestEffectResult {
  ref: PullRequestRef;
  /** How the open PR was resolved (drives whether the engine emits pr_created). */
  via: 'created' | 'reused_by_number' | 'reused_by_head';
}

export interface PullRequestCreatorOptions {
  client: PullRequestClient;
  /** Max attempts (>=1). Defaults to {@link PULL_REQUEST_CREATE_MAX_ATTEMPTS}. */
  maxAttempts?: number;
  /** Backoff base in ms; attempt n waits base * 2^(n-1). Defaults to 500. */
  backoffBaseMs?: number;
  /** Injectable sleep (tests pass a no-op to avoid real timers). */
  sleep?: (ms: number) => Promise<void>;
  /** Whether an error is worth retrying. Defaults to {@link defaultIsRetryable}. */
  isRetryable?: (error: unknown) => boolean;
}

export const PULL_REQUEST_CREATE_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_BASE_MS = 500;

/** The task-correlation marker embedded in the PR body (ADR-019). */
export function taskMarker(taskId: string): string {
  return `<!-- forgeroom:task_id=${taskId} -->`;
}

/** Append the task marker to a body unless it is already present. */
export function withTaskMarker(body: string, taskId: string): string {
  const marker = taskMarker(taskId);
  if (body.includes(marker)) {
    return body;
  }
  const trimmed = body.trimEnd();
  return trimmed.length === 0 ? marker : `${trimmed}\n\n${marker}`;
}

/**
 * Default retry classification: retry anything that is not an explicit
 * non-retryable signal. A primitive that wants to mark a permanent failure
 * (e.g. 422 validation) can throw a {@link NonRetryablePullRequestError}.
 */
export function defaultIsRetryable(error: unknown): boolean {
  return !(error instanceof NonRetryablePullRequestError);
}

/** Thrown by a primitive to opt out of retry for a permanent failure. */
export class NonRetryablePullRequestError extends OrchestratorError {
  constructor(message: string, options?: ErrorOptions) {
    super('pr_create_failed', message, options);
    this.name = 'NonRetryablePullRequestError';
  }
}

/** Final failure after exhausting retries (or a non-retryable error). */
export class PullRequestCreateFailedError extends OrchestratorError {
  readonly attempts: number;

  constructor(message: string, attempts: number, options?: ErrorOptions) {
    super('pr_create_failed', message, options);
    this.name = 'PullRequestCreateFailedError';
    this.attempts = attempts;
  }
}

// ---------------------------------------------------------------------------
// Creator
// ---------------------------------------------------------------------------

export class PullRequestCreator {
  private readonly client: PullRequestClient;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly isRetryable: (error: unknown) => boolean;

  constructor(options: PullRequestCreatorOptions) {
    this.client = options.client;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? PULL_REQUEST_CREATE_MAX_ATTEMPTS);
    this.backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.sleep = options.sleep ?? defaultSleep;
    this.isRetryable = options.isRetryable ?? defaultIsRetryable;
  }

  /**
   * Ensure an open PR exists for the task, retrying with exponential backoff.
   * Each attempt runs the full discovery-before-create sequence so a retry after
   * an ambiguous create never double-creates. Throws
   * {@link PullRequestCreateFailedError} when every attempt fails.
   */
  async ensure(request: PullRequestEffectRequest): Promise<PullRequestEffectResult> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await this.attempt(request);
      } catch (error) {
        lastError = error;
        if (!this.isRetryable(error) || attempt === this.maxAttempts) {
          break;
        }
        await this.sleep(this.backoffBaseMs * 2 ** (attempt - 1));
      }
    }
    throw new PullRequestCreateFailedError(
      `PR creation failed for task ${request.taskId} after ${this.maxAttempts} attempt(s): ${describe(lastError)}`,
      this.maxAttempts,
      lastError instanceof Error ? { cause: lastError } : undefined,
    );
  }

  /** One discovery-before-create pass. */
  private async attempt(request: PullRequestEffectRequest): Promise<PullRequestEffectResult> {
    const body = withTaskMarker(request.body, request.taskId);

    // 1. Known PR -> update body/title, return. No create.
    if (request.prNumber !== null) {
      await this.client.updatePR({
        owner: request.owner,
        repo: request.repo,
        pull_number: request.prNumber,
        body,
        title: request.title,
      });
      return {
        ref: { number: request.prNumber, url: prUrl(request, request.prNumber) },
        via: 'reused_by_number',
      };
    }

    // 2. Discover an open PR by head before creating (idempotency key = id+head).
    const found = await this.client.findOpenPRByHead({
      owner: request.owner,
      repo: request.repo,
      head: request.head,
    });
    if (found !== null) {
      return { ref: found, via: 'reused_by_head' };
    }

    // 3. Create.
    const created = await this.client.createPR({
      owner: request.owner,
      repo: request.repo,
      title: request.title,
      body,
      head: request.head,
      base: request.base,
      draft: request.draft,
    });
    return { ref: created, via: 'created' };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Best-effort PR url for an updated/known PR (the update primitive returns no
 * url). The canonical GitHub PR url is deterministic from owner/repo/number.
 */
function prUrl(request: PullRequestEffectRequest, number: number): string {
  return `https://github.com/${request.owner}/${request.repo}/pull/${number}`;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
