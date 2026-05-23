/**
 * Worktree path + branch naming for the composition root (#30).
 *
 * The PipelineEngine asks the composition root for a task's branch name and
 * absolute worktree path. We encode the project id into the worktree path
 * (`<root>/<projectId>/<taskId>`) so the project-aware git client can resolve
 * which source repo a `git worktree add` belongs to from the path alone (the
 * WorktreeGitClient seam receives only the path, not the project).
 */
import path from 'node:path';

const SLUG_MAX = 40;

/** Branch name for a new task: `forge/<slug>-<short-id>`. Never a protected name. */
export function branchFor(input: { taskId: string; title: string }): string {
  const slug = slugify(input.title) || 'task';
  const shortId = input.taskId.slice(0, 8);
  return `forge/${slug}-${shortId}`;
}

/** Absolute worktree path: `<root>/<projectId>/<taskId>`. */
export function worktreePathFor(input: { root: string; projectId: string; taskId: string }): string {
  return path.join(input.root, input.projectId, input.taskId);
}

/**
 * Recover the project id a worktree path was minted for. Returns null when the
 * path is not under the given root (defends the git client against stray paths).
 */
export function projectIdFromWorktreePath(root: string, worktreePath: string): string | null {
  const rel = path.relative(root, worktreePath);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }
  const [projectId] = rel.split(path.sep);
  return projectId === undefined || projectId === '' ? null : projectId;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
}
