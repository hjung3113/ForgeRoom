/**
 * GitHubStatusClient (#30) — thin Octokit adapter for the Reporter sink.
 *
 * The {@link GitHubReporterSink} (core, #25) maintains one pinned status comment
 * per task and updates the PR body on `pr_created` through the narrow
 * {@link GitHubStatusClient} port (no Octokit types in core). This adapter
 * implements that port over the same {@link GitHubOctokitLike} surface the
 * GitHub gateway already uses, scoped to a single `owner/repo`.
 */
import type { GitHubStatusClient } from '../core/reporter.js';
import type { GitHubOctokitLike } from './github-gateway.js';

/**
 * Octokit issue/PR comment surface this adapter needs, beyond what
 * {@link GitHubOctokitLike} declares. Kept structural so a fake or the real
 * Octokit both satisfy it.
 */
export interface GitHubCommentOctokitLike extends GitHubOctokitLike {
  rest: GitHubOctokitLike['rest'] & {
    issues: GitHubOctokitLike['rest']['issues'] & {
      createComment(args: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }): Promise<{ data: { id: number } }>;
      updateComment(args: {
        owner: string;
        repo: string;
        comment_id: number;
        body: string;
      }): Promise<unknown>;
    };
    pulls: GitHubOctokitLike['rest']['pulls'] & {
      update(args: { owner: string; repo: string; pull_number: number; body?: string }): Promise<unknown>;
    };
  };
}

export interface GitHubStatusClientConfig {
  octokit: GitHubCommentOctokitLike;
  owner: string;
  repo: string;
}

export class OctokitGitHubStatusClient implements GitHubStatusClient {
  private readonly octokit: GitHubCommentOctokitLike;
  private readonly owner: string;
  private readonly repo: string;

  constructor(config: GitHubStatusClientConfig) {
    this.octokit = config.octokit;
    this.owner = config.owner;
    this.repo = config.repo;
  }

  async createIssueComment(issueNumber: number, body: string): Promise<{ id: string }> {
    const { data } = await this.octokit.rest.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      body,
    });
    return { id: String(data.id) };
  }

  async updateIssueComment(commentId: string, body: string): Promise<void> {
    await this.octokit.rest.issues.updateComment({
      owner: this.owner,
      repo: this.repo,
      comment_id: Number(commentId),
      body,
    });
  }

  async updatePrComment(prNumber: number, body: string): Promise<void> {
    await this.octokit.rest.pulls.update({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      body,
    });
  }
}
