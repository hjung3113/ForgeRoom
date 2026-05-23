/**
 * Production WorktreeManager adapters (#30).
 *
 * WorktreeManager (#5) takes a {@link WorktreeGitClient} (git worktree create /
 * existence) and a {@link WorktreeFileSystem} (mkdir / write-if-missing). Only
 * test fakes existed; the composition root needs real ones. Both are thin
 * shells over the git CLI and node fs — no business logic — so they live in
 * `app/` as concrete wiring rather than in `core/`.
 */
import { access, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { WorktreeFileSystem, WorktreeGitClient } from '../core/worktree-manager.js';

const execFileAsync = promisify(execFile);

/** Source repo a worktree path resolves to (cwd + base branch for `git worktree add`). */
export interface WorktreeRepoTarget {
  repoPath: string;
  baseBranch: string;
}

export interface GitCliWorktreeClientOptions {
  /**
   * Resolve which source repo a worktree path belongs to. The seam only carries
   * the path, so the composition root encodes the project id in the path and
   * this resolver maps it back to the repo (see worktree-naming.ts).
   */
  resolveRepo(worktreePath: string): WorktreeRepoTarget;
}

export class GitCliWorktreeClient implements WorktreeGitClient {
  private readonly resolveRepo: (worktreePath: string) => WorktreeRepoTarget;

  constructor(options: GitCliWorktreeClientOptions) {
    this.resolveRepo = options.resolveRepo;
  }

  async worktreeExists(worktreePath: string): Promise<boolean> {
    const { repoPath } = this.resolveRepo(worktreePath);
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoPath,
    });
    return stdout.split('\n').some((line) => line === `worktree ${worktreePath}`);
  }

  async createWorktree(input: { path: string; branch: string }): Promise<void> {
    const { repoPath, baseBranch } = this.resolveRepo(input.path);
    // -b creates the branch off the project base branch; the worktree dir is
    // created by git. ApprovalGate has already cleared the path/branch.
    await execFileAsync('git', ['worktree', 'add', '-b', input.branch, input.path, baseBranch], {
      cwd: repoPath,
    });
  }
}

export class NodeWorktreeFileSystem implements WorktreeFileSystem {
  async ensureDir(dirPath: string): Promise<void> {
    await mkdir(dirPath, { recursive: true });
  }

  async writeFileIfMissing(filePath: string, content: string): Promise<void> {
    try {
      await access(filePath);
    } catch {
      await writeFile(filePath, content);
    }
  }
}
