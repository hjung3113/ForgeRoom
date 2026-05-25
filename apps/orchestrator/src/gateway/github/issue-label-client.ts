import type {
  AddIssueLabelArgs,
  GitHubOctokitLike,
  RemoveIssueLabelArgs,
} from './types.js';

/**
 * Thin Octokit wrappers for GitHub issue label mutation.
 *
 * No idempotency policy lives here. Missing labels, 404s, and retry semantics
 * are owned by the future caller/effect layer.
 */
export class GitHubIssueLabelClient {
  constructor(private readonly octokit: GitHubOctokitLike) {}

  async addLabel(args: AddIssueLabelArgs): Promise<void> {
    const addLabels = this.octokit.rest.issues.addLabels;
    if (addLabels === undefined) {
      throw new Error('GitHub issues.addLabels is not available');
    }
    await addLabels({
      owner: args.owner,
      repo: args.repo,
      issue_number: args.issue_number,
      labels: args.labels,
    });
  }

  async removeLabel(args: RemoveIssueLabelArgs): Promise<void> {
    const removeLabel = this.octokit.rest.issues.removeLabel;
    if (removeLabel === undefined) {
      throw new Error('GitHub issues.removeLabel is not available');
    }
    await removeLabel({
      owner: args.owner,
      repo: args.repo,
      issue_number: args.issue_number,
      name: args.name,
    });
  }
}
