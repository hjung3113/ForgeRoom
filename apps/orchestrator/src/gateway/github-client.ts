/**
 * GitHub client factory (#30) — constructs the real Octokit instance.
 *
 * Octokit is instantiated here, at the gateway boundary, so core never imports
 * it. The returned client is shared by {@link GitHubIssueTaskSource},
 * {@link GitHubPullRequestClient}, and {@link OctokitGitHubStatusClient}; each
 * uses the structural `*OctokitLike` surface it needs, so this single concrete
 * client satisfies all three.
 */
import { Octokit } from 'octokit';

import type { GitHubCommentOctokitLike } from './github-status-client.js';

/**
 * Build an authenticated Octokit. The real `Octokit` from the `octokit` package
 * structurally satisfies {@link GitHubCommentOctokitLike} (and the narrower
 * gateway surfaces); the cast localises the SDK→port adaptation to one spot.
 */
export function createGitHubClient(token: string): GitHubCommentOctokitLike {
  const octokit = new Octokit({ auth: token });
  return octokit as unknown as GitHubCommentOctokitLike;
}
