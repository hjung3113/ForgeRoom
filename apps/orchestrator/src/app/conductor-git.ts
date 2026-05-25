import { rm } from 'node:fs/promises';
import path from 'node:path';

import type { ConductorGit } from '../core/conductor/conductor.js';
import { GitCli } from './git-cli.js';

export interface GitCliConductorGitOptions {
  git?: Pick<GitCli, 'statusPorcelainZPaths' | 'restoreFromHead' | 'isTracked'>;
}

/**
 * Production ConductorGit backed by the git CLI. Scope-guard policy stays here:
 * restore failures are swallowed, and only paths still untracked after restore
 * are deleted.
 */
export class GitCliConductorGit implements ConductorGit {
  private readonly git: Pick<GitCli, 'statusPorcelainZPaths' | 'restoreFromHead' | 'isTracked'>;

  constructor(options: GitCliConductorGitOptions = {}) {
    this.git = options.git ?? new GitCli();
  }

  async status(cwd: string): Promise<string[]> {
    return this.git.statusPorcelainZPaths(cwd);
  }

  async revert(cwd: string, paths: string[]): Promise<void> {
    if (paths.length === 0) {
      return;
    }

    try {
      await this.git.restoreFromHead({ cwd, paths });
    } catch {
      // Path may be entirely untracked (no HEAD entry); the rm below handles it.
    }

    await Promise.all(
      paths.map(async (rel) => {
        const isTracked = await this.git.isTracked({ cwd, rel });
        if (!isTracked) {
          await rm(path.join(cwd, rel), { force: true, recursive: true });
        }
      }),
    );
  }
}
