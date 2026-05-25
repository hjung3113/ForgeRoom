/**
 * Production ForgeMap seam adapters (#30).
 *
 * The ForgeMapStagerImpl (#26) needs three injected seams. #26 delivered only
 * the stager; the canonical-map BUILDER is a future issue. The composition root
 * therefore wires:
 *   - {@link GitCliRepoStateProbe} — real git HEAD + dirty probe.
 *   - {@link TaskStoreContextLookup} — per-task selection signals from the
 *     authoritative task row (title/description; no approvals/changed-paths yet).
 *   - {@link BootstrapForgeMapStore} — a deliberately minimal store whose
 *     `build()` returns an empty-but-valid record (project-profile only). It is
 *     visibly temporary and does NOT pretend to build a canonical map.
 *
 * This keeps the stage hook honestly wired (it produces a valid, near-empty
 * `.forgeroom/context/`) without the missing map-builder.
 */
import type {
  ForgeMapRecord,
  ForgeMapStore,
  RepoStateProbe,
  StageTaskContext,
  TaskContextLookup,
  WorktreeKind,
} from '../core/context/forgemap.js';
import type { TaskStore } from '../core/task-store.js';
import type { WorkflowRegistry } from '../core/registries/workflow-registry.js';
import type { ProjectRegistry } from '../core/registries/project-registry.js';
import { GitCli } from './git-cli.js';

export class GitCliRepoStateProbe implements RepoStateProbe {
  private readonly git: GitCli;

  constructor(options: { git?: GitCli } = {}) {
    this.git = options.git ?? new GitCli();
  }

  async head(repoPath: string): Promise<{ commit: string; dirty: boolean }> {
    const [commit, status] = await Promise.all([
      this.git.revParseHead(repoPath),
      this.git.statusPorcelain(repoPath),
    ]);
    return { commit, dirty: status.trim().length > 0 };
  }
}

export interface TaskStoreContextLookupDeps {
  taskStore: Pick<TaskStore, 'getTask' | 'getDirtyBaselineApprover'>;
  projectRegistry: ProjectRegistry;
  workflowRegistry: WorkflowRegistry;
}

/**
 * Resolves the per-task selection signals from the authoritative task row plus
 * the workflow's worktree effect. MVP signals: title/description, worktree kind,
 * and the dirty-baseline approver read back from the recorded
 * `dirty_baseline_approved` event (ADR-013, #42) — so an approved dirty baseline
 * proceeds and an unapproved one blocks (forgemap.md). Pending-rebuild approval
 * has no recording path yet, so it stays null (its event source is a later issue).
 */
export class TaskStoreContextLookup implements TaskContextLookup {
  private readonly taskStore: Pick<TaskStore, 'getTask' | 'getDirtyBaselineApprover'>;
  private readonly workflowRegistry: WorkflowRegistry;

  constructor(deps: TaskStoreContextLookupDeps) {
    this.taskStore = deps.taskStore;
    this.workflowRegistry = deps.workflowRegistry;
  }

  async forTask(taskId: string): Promise<StageTaskContext> {
    const task = await this.taskStore.getTask(taskId);
    if (task === null) {
      throw new Error(`forgemap context lookup: unknown task ${taskId}`);
    }
    const workflow = this.workflowRegistry.get(task.workflow_id);
    const worktreeKind: WorktreeKind = workflow?.effects.worktree === 'read_only' ? 'read_only' : 'modifies';
    const dirtyBaselineApprovedBy = await this.taskStore.getDirtyBaselineApprover(taskId);
    return {
      title: task.title,
      description: task.description,
      worktreeKind,
      dirtyBaselineApprovedBy,
      pendingRebuildApprovedBy: null,
      changedPaths: [],
    };
  }
}

export interface BootstrapForgeMapStoreDeps {
  projectRegistry: ProjectRegistry;
  repoProbe: RepoStateProbe;
}

/**
 * Minimal bootstrap ForgeMap store: no canonical map exists yet, so `get()`
 * returns null and `build()` returns an empty-but-valid record carrying only a
 * project-profile doc and the live source revision. Visibly temporary — the
 * real ForgeMapBuilder is a separate issue.
 */
export class BootstrapForgeMapStore implements ForgeMapStore {
  private readonly projectRegistry: ProjectRegistry;
  private readonly repoProbe: RepoStateProbe;

  constructor(deps: BootstrapForgeMapStoreDeps) {
    this.projectRegistry = deps.projectRegistry;
    this.repoProbe = deps.repoProbe;
  }

  get(_projectId: string): Promise<ForgeMapRecord | null> {
    return Promise.resolve(null);
  }

  async build(projectId: string): Promise<ForgeMapRecord> {
    const project = this.projectRegistry.get(projectId);
    if (project === null) {
      throw new Error(`bootstrap forgemap build: unknown project ${projectId}`);
    }
    const head = await this.repoProbe.head(project.path);
    return {
      projectId,
      source: {
        repoPath: project.path,
        defaultBranch: project.default_branch,
        indexedCommit: head.commit,
        indexedDirty: head.dirty,
        indexedAt: new Date().toISOString(),
      },
      docs: [
        {
          purpose: 'project-profile',
          relPath: 'project-profile.md',
          content: `# ${projectId}\n\n(No canonical ForgeMap built yet; bootstrap profile.)\n`,
          summary: `Bootstrap profile for ${projectId}`,
          keywords: [projectId],
        },
      ],
    };
  }
}
