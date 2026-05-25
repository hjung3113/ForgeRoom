import type {
  CreatePRArgs,
  FindOpenPRArgs,
  GitHubOctokitLike,
  PRRef,
  UpdatePRArgs,
} from './types.js';

/**
 * Thin Octokit wrappers for PR create/update plus a discovery helper.
 *
 * No retry loop, no idempotency orchestration — those belong to the
 * PipelineEngine external effect (ADR-019). Each method is a single API call.
 */
export class GitHubPullRequestClient {
  constructor(private readonly octokit: GitHubOctokitLike) {}

  async createPR(args: CreatePRArgs): Promise<PRRef> {
    const params: Parameters<GitHubOctokitLike['rest']['pulls']['create']>[0] = {
      owner: args.owner,
      repo: args.repo,
      title: args.title,
      body: args.body,
      head: args.head,
      base: args.base,
    };
    if (args.draft !== undefined) {
      params.draft = args.draft;
    }
    const { data } = await this.octokit.rest.pulls.create(params);
    return { number: data.number, url: data.html_url };
  }

  async updatePR(args: UpdatePRArgs): Promise<void> {
    const params: Parameters<GitHubOctokitLike['rest']['pulls']['update']>[0] = {
      owner: args.owner,
      repo: args.repo,
      pull_number: args.pull_number,
    };
    if (args.body !== undefined) {
      params.body = args.body;
    }
    if (args.title !== undefined) {
      params.title = args.title;
    }
    await this.octokit.rest.pulls.update(params);
  }

  /**
   * Discovery helper for the PR-effect layer: find an open PR for `head`.
   * Returns the first match or null. Does not create or persist anything.
   */
  async findOpenPRByHead(args: FindOpenPRArgs): Promise<PRRef | null> {
    const { data } = await this.octokit.rest.pulls.list({
      owner: args.owner,
      repo: args.repo,
      head: `${args.owner}:${args.head}`,
      state: 'open',
    });
    const first = data[0];
    return first === undefined ? null : { number: first.number, url: first.html_url };
  }
}
