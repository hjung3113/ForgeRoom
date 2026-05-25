/**
 * BranchPublisher — branch-publication external effect (ADR-025, #63).
 *
 * Commits worktree changes and pushes the branch BEFORE the PR external effect.
 * Runs on every success path; when the worktree has no diff (git status --porcelain
 * is empty) the publish is skipped and the caller receives `noDiff: true` so the
 * engine can take the no-diff terminal-success path (no PR, comment, task done).
 *
 * Core stays gateway-free: depends on the injected {@link BranchPublishPort}
 * interface; the concrete git-cli-backed impl is wired at the composition root.
 */
import { OrchestratorError } from '../errors.js';

// ---------------------------------------------------------------------------
// Injected primitive (gateway-free seam; satisfied by GitCli in app layer)
// ---------------------------------------------------------------------------

/**
 * Narrow git operations the publisher needs. Core depends on this interface;
 * `GitCli` from `app/git-cli.ts` provides the concrete implementation. Keeps
 * core free of child_process / fs imports (AGENTS.md rule 1).
 */
export interface BranchPublishPort {
  /** Returns `git status --porcelain` output (empty string = clean worktree). */
  statusPorcelain(cwd: string): Promise<string>;
  /** Stage all changes and create a commit in the worktree. */
  commit(input: { cwd: string; message: string }): Promise<void>;
  /** Push the branch to the given remote (defaults to 'origin' when omitted). */
  push(input: { cwd: string; branch: string; remote?: string }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Request / result
// ---------------------------------------------------------------------------

export interface BranchPublishRequest {
  /** The task id (used in error messages). */
  taskId: string;
  /** Absolute path to the worktree. */
  cwd: string;
  /** Branch name to push (the PR head). */
  branch: string;
  /** Commit message to use when there are changes to commit. */
  commitMessage: string;
  /** Git remote to push to; omit to use the port's default. */
  remote?: string;
}

export interface BranchPublishResult {
  /**
   * True when the worktree had no staged/unstaged changes. The engine uses this
   * signal to skip PR creation and take the no-diff terminal-success path.
   */
  noDiff: boolean;
}

export interface BranchPublisherOptions {
  port: BranchPublishPort;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when commit or push fails; wraps the underlying cause. */
export class BranchPublishFailedError extends OrchestratorError {
  constructor(message: string, options?: ErrorOptions) {
    super('branch_publish_failed', message, options);
    this.name = 'BranchPublishFailedError';
  }
}

// ---------------------------------------------------------------------------
// Publisher
// ---------------------------------------------------------------------------

export class BranchPublisher {
  private readonly port: BranchPublishPort;

  constructor(options: BranchPublisherOptions) {
    this.port = options.port;
  }

  /**
   * Publish the worktree branch.
   *
   * 1. Run `git status --porcelain` on the worktree.
   * 2. If output is empty (no changes), return `{ noDiff: true }` immediately.
   * 3. Otherwise commit all changes, then push the branch.
   * 4. Wrap any commit/push failure in {@link BranchPublishFailedError}.
   */
  async publish(request: BranchPublishRequest): Promise<BranchPublishResult> {
    const status = await this.port.statusPorcelain(request.cwd);

    if (status.trim().length === 0) {
      return { noDiff: true };
    }

    try {
      await this.port.commit({ cwd: request.cwd, message: request.commitMessage });
    } catch (error) {
      throw new BranchPublishFailedError(
        `Branch publication failed (commit) for task ${request.taskId}: ${describe(error)}`,
        error instanceof Error ? { cause: error } : undefined,
      );
    }

    try {
      await this.port.push({ cwd: request.cwd, branch: request.branch, remote: request.remote });
    } catch (error) {
      throw new BranchPublishFailedError(
        `Branch publication failed (push) for task ${request.taskId}: ${describe(error)}`,
        error instanceof Error ? { cause: error } : undefined,
      );
    }

    return { noDiff: false };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
