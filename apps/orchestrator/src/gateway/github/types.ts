export interface GitHubIssueLabel {
  name: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels: Array<GitHubIssueLabel | string>;
  /** Present on the issues endpoint when the row is actually a pull request. */
  pull_request?: unknown;
}

export interface GitHubPullData {
  number: number;
  html_url: string;
}

/**
 * The subset of Octokit (`octokit` package, `octokit.rest`) this adapter uses.
 * Declared structurally so a fake or `nock`-backed real `Octokit` both satisfy it.
 */
export interface GitHubOctokitLike {
  rest: {
    issues: {
      listForRepo(args: {
        owner: string;
        repo: string;
        labels?: string;
        state?: 'open' | 'closed' | 'all';
        per_page?: number;
      }): Promise<{ data: GitHubIssue[] }>;
      addLabels?(args: {
        owner: string;
        repo: string;
        issue_number: number;
        labels: string[];
      }): Promise<unknown>;
      removeLabel?(args: {
        owner: string;
        repo: string;
        issue_number: number;
        name: string;
      }): Promise<unknown>;
    };
    pulls: {
      create(args: {
        owner: string;
        repo: string;
        title: string;
        body: string;
        head: string;
        base: string;
        draft?: boolean;
      }): Promise<{ data: GitHubPullData }>;
      update(args: {
        owner: string;
        repo: string;
        pull_number: number;
        body?: string;
        title?: string;
      }): Promise<{ data: GitHubPullData }>;
      list(args: {
        owner: string;
        repo: string;
        head?: string;
        base?: string;
        state?: 'open' | 'closed' | 'all';
      }): Promise<{ data: GitHubPullData[] }>;
    };
  };
}

export interface GitHubGatewayLogger {
  warn(message: string): void;
  error(message: string): void;
}

export interface GitHubRepoPoll {
  projectId: string;
  owner: string;
  repo: string;
  /** Trigger label. Defaults to `agent` if omitted. */
  label?: string;
}

/** Either one shared client, or a per-repo resolver. */
export type OctokitResolver = GitHubOctokitLike | ((repo: GitHubRepoPoll) => GitHubOctokitLike);

export interface PRRef {
  number: number;
  url: string;
}

export interface CreatePRArgs {
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
  draft?: boolean;
}

export interface UpdatePRArgs {
  owner: string;
  repo: string;
  pull_number: number;
  body?: string;
  title?: string;
}

export interface FindOpenPRArgs {
  owner: string;
  repo: string;
  /** Branch name (without the `owner:` qualifier). */
  head: string;
}

export interface AddIssueLabelArgs {
  owner: string;
  repo: string;
  issue_number: number;
  labels: string[];
}

export interface RemoveIssueLabelArgs {
  owner: string;
  repo: string;
  issue_number: number;
  name: string;
}
