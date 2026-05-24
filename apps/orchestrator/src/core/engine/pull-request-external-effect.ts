import type { ProjectMeta } from '../project-registry.js';
import {
  PullRequestCreateFailedError,
  type PullRequestCreator,
  type PullRequestEffectRequest,
} from '../pull-request-creator.js';
import type { TaskStore } from '../task-store.js';
import type { Reporter, Task } from '../types.js';
import type { WorkflowPrEffect } from '../../workflow/types.js';

interface PullRequestTarget {
  owner: string;
  repo: string;
  base: string;
}

export interface PullRequestExternalEffectOptions {
  pullRequestCreator?: PullRequestCreator;
  prTargetFor?: (input: { task: Task; project: ProjectMeta }) => PullRequestTarget | null;
  taskStore: Pick<TaskStore, 'getTask' | 'setPrNumber'>;
  reporter: Pick<Reporter, 'notify'>;
  log: (line: string) => void;
}

export class PullRequestExternalEffect {
  private readonly pullRequestCreator?: PullRequestCreator;
  private readonly prTargetFor?: (input: { task: Task; project: ProjectMeta }) => PullRequestTarget | null;
  private readonly taskStore: Pick<TaskStore, 'getTask' | 'setPrNumber'>;
  private readonly reporter: Pick<Reporter, 'notify'>;
  private readonly log: (line: string) => void;

  constructor(options: PullRequestExternalEffectOptions) {
    this.pullRequestCreator = options.pullRequestCreator;
    this.prTargetFor = options.prTargetFor;
    this.taskStore = options.taskStore;
    this.reporter = options.reporter;
    this.log = options.log;
  }

  /**
   * Workflow external effect (ADR-019): create or reuse the task's PR.
   *
   * Runs only when `effects.external.pr != none`, a {@link PullRequestCreator}
   * is wired, and the project resolves a PR target. The current `pr_number` is
   * re-read from the authoritative store (not the pre-run task snapshot) so a
   * recoverPending() replay reuses the existing PR instead of double-creating.
   * On success the engine persists `pr_number` and emits `pr_created` (Reporter
   * delivers; the engine does NOT touch PR comments). A final failure propagates
   * so settle fails the task with `pr_create_failed`.
   */
  async run(input: { task: Task; project: ProjectMeta; prEffect: WorkflowPrEffect }): Promise<void> {
    const { task, project, prEffect } = input;
    if (prEffect === 'none') {
      return;
    }
    const creator = this.pullRequestCreator;
    const target = this.prTargetFor?.({ task, project }) ?? null;
    if (creator === undefined || target === null) {
      this.log(
        `pr-effect: task ${task.id} effects.external.pr=${prEffect} but ${
          creator === undefined ? 'no PullRequestCreator wired' : 'no PR target resolved'
        }; skipping`,
      );
      return;
    }

    // Re-read the authoritative pr_number (idempotency across replays).
    const current = await this.taskStore.getTask(task.id);
    const prNumber = current?.pr_number ?? null;

    const request: PullRequestEffectRequest = {
      taskId: task.id,
      prNumber,
      owner: target.owner,
      repo: target.repo,
      head: task.branch_name,
      base: target.base,
      title: task.title,
      body: task.description,
      draft: prEffect === 'draft',
    };

    let result;
    try {
      result = await creator.ensure(request);
    } catch (error) {
      // Normalise to a typed failure so settle records pr_create_failed.
      if (error instanceof PullRequestCreateFailedError) {
        throw error;
      }
      throw new PullRequestCreateFailedError(
        `PR external effect failed for task ${task.id}: ${error instanceof Error ? error.message : String(error)}`,
        0,
        error instanceof Error ? { cause: error } : undefined,
      );
    }

    // Persist pr_number (no-op write if unchanged) then emit pr_created so the
    // Reporter best-effort updates the PR surface (ADR-019).
    if (result.ref.number !== prNumber) {
      await this.taskStore.setPrNumber(task.id, result.ref.number);
    }
    await this.reporter.notify({
      type: 'pr_created',
      task: { ...task, pr_number: result.ref.number },
      pr_number: result.ref.number,
      pr_url: result.ref.url,
    });
  }
}
