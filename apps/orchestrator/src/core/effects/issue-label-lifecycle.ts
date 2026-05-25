/**
 * IssueLabelLifecycleEffect — terminal-state label transition (ADR-026, #64).
 *
 * After a task reaches a terminal status (`done` or `failed`), this effect
 * transitions the triggering GitHub Issue's triage label:
 *
 *   done   → removes `ready-for-agent`, adds `ready-for-human`
 *   failed → removes `ready-for-agent`, adds `needs-info`
 *
 * Contract:
 *  - SIDE-EFFECT ONLY: never mutates task state.
 *  - NO-OP when the task was not triggered by a GitHub issue label
 *    (i.e. `source !== 'github-issue-label'` or `issue_number === null`).
 *  - Failure NEVER propagates: errors are caught, logged, and swallowed so
 *    the settle outcome is not altered (ADR-026).
 *
 * Core stays gateway-free: the narrow {@link IssueLabelPort} is injected at
 * the composition root; the concrete Octokit-backed implementation lives in
 * `gateway/github/issue-label-client.ts`.
 *
 * Assumption (flagged): an in-flight agent task is assumed to carry the
 * `ready-for-agent` triage label. The effect removes it unconditionally before
 * adding the terminal label. If the label is already absent, GitHub returns
 * 404 which is intentionally swallowed by the failure isolation wrapper.
 */

import type { Task } from '../types.js';

// ---------------------------------------------------------------------------
// Injected narrow port (gateway-free seam — ADR-026)
// ---------------------------------------------------------------------------

export interface AddLabelArgs {
  owner: string;
  repo: string;
  issue_number: number;
  labels: string[];
}

export interface RemoveLabelArgs {
  owner: string;
  repo: string;
  issue_number: number;
  name: string;
}

/**
 * Narrow seam the effect depends on. Structurally matches
 * `GitHubIssueLabelClient` in `gateway/github/issue-label-client.ts` so the
 * concrete adapter satisfies it without a gateway import in core.
 */
export interface IssueLabelPort {
  addLabel(args: AddLabelArgs): Promise<void>;
  removeLabel(args: RemoveLabelArgs): Promise<void>;
}

// ---------------------------------------------------------------------------
// Request type
// ---------------------------------------------------------------------------

export interface LabelLifecycleRequest {
  task: Task;
  /** The terminal status that just settled (only `done` and `failed` trigger label transitions). */
  terminalStatus: 'done' | 'failed';
  /** GitHub owner resolved by the composition root. */
  owner: string;
  /** GitHub repo resolved by the composition root. */
  repo: string;
}

// ---------------------------------------------------------------------------
// Label constants (canonical strings from docs/agents/triage-labels.md;
// re-exported from gateway/github/triage-labels.ts at the composition root
// boundary — imported here via string literals so core stays gateway-free).
// ---------------------------------------------------------------------------

const LABEL_READY_FOR_AGENT = 'ready-for-agent';
const LABEL_READY_FOR_HUMAN = 'ready-for-human';
const LABEL_NEEDS_INFO = 'needs-info';

// ---------------------------------------------------------------------------
// Effect
// ---------------------------------------------------------------------------

export interface IssueLabelLifecycleEffectOptions {
  port: IssueLabelPort;
  log: (line: string) => void;
}

export class IssueLabelLifecycleEffect {
  private readonly port: IssueLabelPort;
  private readonly log: (line: string) => void;

  constructor(options: IssueLabelLifecycleEffectOptions) {
    this.port = options.port;
    this.log = options.log;
  }

  /**
   * Apply the triage-label transition for a settled task.
   *
   * Always resolves (never rejects): any port error is caught and logged so
   * the settle outcome is not altered (ADR-026 failure isolation).
   */
  async apply(request: LabelLifecycleRequest): Promise<void> {
    const { task, terminalStatus, owner, repo } = request;

    // No-op: task was not triggered by a GitHub issue label.
    if (task.source !== 'github-issue-label' || task.issue_number === null) {
      this.log(
        `label-lifecycle: task ${task.id} source=${task.source} issue_number=${String(task.issue_number)}; skipping`,
      );
      return;
    }

    const issueNumber = task.issue_number;
    const targetLabel =
      terminalStatus === 'done' ? LABEL_READY_FOR_HUMAN : LABEL_NEEDS_INFO;

    try {
      // Remove the in-flight label first (assumption: task was `ready-for-agent`
      // while the agent was running). A 404 from GitHub is swallowed below.
      await this.port.removeLabel({
        owner,
        repo,
        issue_number: issueNumber,
        name: LABEL_READY_FOR_AGENT,
      });
      await this.port.addLabel({
        owner,
        repo,
        issue_number: issueNumber,
        labels: [targetLabel],
      });
      this.log(
        `label-lifecycle: task ${task.id} issue #${issueNumber} → ${targetLabel}`,
      );
    } catch (error) {
      // Failure isolation: log, never rethrow (ADR-026).
      const message = error instanceof Error ? error.message : String(error);
      this.log(
        `label-lifecycle: task ${task.id} issue #${issueNumber} label transition failed (non-fatal): ${message}`,
      );
    }
  }
}
