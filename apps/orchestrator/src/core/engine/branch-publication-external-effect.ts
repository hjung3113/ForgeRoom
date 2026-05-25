/**
 * BranchPublicationExternalEffect — engine wrapper for the branch-publication
 * external effect (ADR-025, #63).
 *
 * Mirrors PullRequestExternalEffect: thin wrapper that owns the "is wired?"
 * guard and delegates the actual work to an injected {@link BranchPublisher}.
 * The engine calls `run()` in the success path BEFORE the PR external effect.
 *
 * When the run produces no diff (git status --porcelain is empty), `run()`
 * returns `{ noDiff: true }` so the caller (settle) can skip PR creation,
 * emit `task_done_no_diff`, and mark the task done without a PR.
 */
import type { BranchPublisher } from '../effects/branch-publisher.js';
import type { Task } from '../types.js';

export interface BranchPublicationExternalEffectOptions {
  branchPublisher?: BranchPublisher;
  /** Commit message for the agent-output commit (defaults to a sensible fallback). */
  commitMessage?: (task: Task) => string;
  /** Git remote to push to (defaults to 'origin'). */
  remote?: string;
  log: (line: string) => void;
}

export interface BranchPublicationResult {
  /** True when the worktree had no changes — caller should skip PR and emit no-diff event. */
  noDiff: boolean;
}

export class BranchPublicationExternalEffect {
  private readonly branchPublisher?: BranchPublisher;
  private readonly commitMessage: (task: Task) => string;
  private readonly remote?: string;
  private readonly log: (line: string) => void;

  constructor(options: BranchPublicationExternalEffectOptions) {
    this.branchPublisher = options.branchPublisher;
    this.commitMessage =
      options.commitMessage ?? ((task) => `chore: agent output for task ${task.id}`);
    this.remote = options.remote;
    this.log = options.log;
  }

  /**
   * Publish the worktree branch.
   *
   * - If no `BranchPublisher` is wired, returns `{ noDiff: false }` immediately
   *   (legacy projects without publish wiring fall through to PR creation).
   * - Otherwise delegates to `BranchPublisher.publish()`. A `noDiff: true` result
   *   means no commit/push happened and the caller should skip PR creation.
   * - Throws {@link BranchPublishFailedError} (re-thrown from the publisher) when
   *   commit or push fails; the engine maps this to a task failure.
   */
  async run(input: { task: Task }): Promise<BranchPublicationResult> {
    const { task } = input;

    if (this.branchPublisher === undefined) {
      this.log(`branch-publication: task ${task.id} no BranchPublisher wired; skipping`);
      return { noDiff: false };
    }

    const result = await this.branchPublisher.publish({
      taskId: task.id,
      cwd: task.worktree_path,
      branch: task.branch_name,
      commitMessage: this.commitMessage(task),
      remote: this.remote,
    });

    if (result.noDiff) {
      this.log(`branch-publication: task ${task.id} no diff; skipping commit+push`);
    }

    return result;
  }
}
