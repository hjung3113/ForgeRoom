/**
 * ForgeMap + ForgeMapStager (#26, ADR-014, Docs/modules/forgemap.md).
 *
 * ForgeMap is the canonical per-project context substrate: per-purpose markdown
 * docs plus a minimal structured index, NOT one giant summary. At task start the
 * orchestrator stages the *selected subset* into the task worktree
 * `.forgeroom/context/` as snapshot copies (no symlinks — sandbox/portability).
 *
 * This module implements the {@link ForgeMapStager} seam owned by
 * pipeline-engine.ts: `stage({ taskId, worktreePath, projectId })`. The seam is
 * intentionally minimal; everything else (the canonical store, the target-repo
 * state probe, and per-task selection signals) is injected via the constructor
 * so the seam stays a stable orchestration hook (codex-confirmed, conf 88).
 *
 * Stale/dirty policy (forgemap.md "Source revision" + "Refresh classification"):
 *   - indexed_commit == HEAD && clean        -> use existing map.
 *   - HEAD moved && clean                     -> refresh-then-proceed (logged).
 *   - dirty target repo                       -> block (throw) unless a
 *                                                maintainer approved a dirty
 *                                                baseline; then record it.
 *   - pending rebuild + modification workflow -> block unless approved.
 *   - pending rebuild + read-only workflow    -> proceed with a warning.
 *
 * Blocking is signalled by THROWING a typed error (the seam returns
 * `Promise<void>`, and a stale/dirty baseline is a precondition failure, not a
 * normal result — codex-confirmed, conf 82).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { OrchestratorError } from './errors.js';
import { isSecretPath, safeJoinInsideRoot } from '../utils/path-safety.js';

// ---------------------------------------------------------------------------
// Domain model
// ---------------------------------------------------------------------------

/** Purpose-specific document kinds (forgemap.md "문서 역할"). */
export type ForgeMapPurpose =
  | 'project-profile'
  | 'architecture-map'
  | 'module-index'
  | 'dependency-map'
  | 'command-map'
  | 'testing-map'
  | 'risk-map'
  | 'decisions-index'
  | 'folder';

/** A single canonical ForgeMap document plus its selection hints. */
export interface ForgeMapDoc {
  /** Stable symbol id used for `depends_on` edges; defaults to relPath. */
  id?: string;
  purpose: ForgeMapPurpose;
  /** Path under the map root, also the staged path under context/docs/. */
  relPath: string;
  content: string;
  summary: string;
  keywords: string[];
  /** 1-hop dependency symbol ids (forgemap.md MVP selection rule). */
  dependsOn?: string[];
}

/** Provenance of the indexed source repo (forgemap.yaml `source`). */
export interface ForgeMapSource {
  repoPath: string;
  defaultBranch: string;
  indexedCommit: string;
  indexedDirty: boolean;
  indexedAt: string;
  /** True when a structural change requires a full rebuild before modifying. */
  pendingRebuild?: boolean;
}

/** A loaded canonical ForgeMap for one project. */
export interface ForgeMapRecord {
  projectId: string;
  source: ForgeMapSource;
  docs: ForgeMapDoc[];
}

/**
 * Canonical ForgeMap store (forgemap.md `ForgeMapStore` + `ForgeMapBuilder`,
 * narrowed to what the stager needs). `build` is the lazy onboarding path used
 * when no map exists yet.
 */
export interface ForgeMapStore {
  get(projectId: string): Promise<ForgeMapRecord | null>;
  build(projectId: string): Promise<ForgeMapRecord>;
}

/** Reads the current HEAD commit + dirty flag of the target repo. */
export interface RepoStateProbe {
  head(repoPath: string): Promise<{ commit: string; dirty: boolean }>;
}

/** The worktree effect of the task's workflow (workflow-dsl `effects.worktree`). */
export type WorktreeKind = 'read_only' | 'modifies';

/** Per-task selection + approval signals not carried by the minimal seam. */
export interface StageTaskContext {
  title: string;
  description: string;
  worktreeKind: WorktreeKind;
  /** Maintainer who approved running on a dirty baseline; null if none. */
  dirtyBaselineApprovedBy: string | null;
  /** Maintainer who approved a modification on a pending-rebuild map. */
  pendingRebuildApprovedBy: string | null;
  /** Worktree-relative changed paths to bias selection (referenced_path). */
  changedPaths: string[];
}

export interface TaskContextLookup {
  forTask(taskId: string): Promise<StageTaskContext>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when the target repo is dirty without an approved dirty baseline. */
export class ForgeMapStaleError extends OrchestratorError {
  constructor(
    message: string,
    readonly projectId: string,
    readonly dirty: boolean,
  ) {
    super('agent_error', message);
    this.name = 'ForgeMapStaleError';
  }
}

/** Thrown when a modification workflow runs on a pending-rebuild map unapproved. */
export class ForgeMapPendingRebuildError extends OrchestratorError {
  constructor(
    message: string,
    readonly projectId: string,
  ) {
    super('agent_error', message);
    this.name = 'ForgeMapPendingRebuildError';
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** Auditable reason a doc entered the selection (forgemap.md hard signals). */
type ContextExpansionReason =
  | 'project_profile_baseline'
  | 'referenced_path'
  | 'matched_symbol'
  | '1hop_depends_on'
  | 'workflow_kind_requires_rule';

interface SelectedDoc {
  doc: ForgeMapDoc;
  reason: ContextExpansionReason;
  signal: string;
}

interface StageInput {
  taskId: string;
  worktreePath: string;
  projectId: string;
}

const FORGEMAP_STAGER_DEFAULTS = {
  now: (): Date => new Date(),
};

export interface ForgeMapStagerDeps {
  store: ForgeMapStore;
  repoProbe: RepoStateProbe;
  taskLookup: TaskContextLookup;
  now?: () => Date;
}

export class ForgeMapStagerImpl {
  private readonly store: ForgeMapStore;
  private readonly repoProbe: RepoStateProbe;
  private readonly taskLookup: TaskContextLookup;
  private readonly now: () => Date;

  constructor(deps: ForgeMapStagerDeps) {
    this.store = deps.store;
    this.repoProbe = deps.repoProbe;
    this.taskLookup = deps.taskLookup;
    this.now = deps.now ?? FORGEMAP_STAGER_DEFAULTS.now;
  }

  async stage(input: StageInput): Promise<void> {
    const record = (await this.store.get(input.projectId)) ?? (await this.store.build(input.projectId));
    const taskCtx = await this.taskLookup.forTask(input.taskId);
    const repo = await this.repoProbe.head(record.source.repoPath);

    const verdict = this.classify(record.source, repo, taskCtx, input.projectId);

    const selection = selectDocs(record.docs, taskCtx);
    await this.writeStaging(input.worktreePath, record, selection, verdict);
  }

  /**
   * Decide whether staging may proceed, and with what provenance notes. Throws
   * a typed error for the block cases (forgemap.md "Source revision" /
   * "Refresh classification").
   */
  private classify(
    source: ForgeMapSource,
    repo: { commit: string; dirty: boolean },
    taskCtx: StageTaskContext,
    projectId: string,
  ): StagingVerdict {
    const notes: string[] = [];

    if (source.pendingRebuild === true) {
      if (taskCtx.pendingRebuildApprovedBy !== null) {
        notes.push(
          `pending rebuild: maintainer ${taskCtx.pendingRebuildApprovedBy} approved running on a stale-structure map`,
        );
      } else if (taskCtx.worktreeKind === 'read_only') {
        notes.push('pending rebuild: read-only workflow proceeding on a stale-structure map (warning)');
      } else {
        throw new ForgeMapPendingRebuildError(
          `ForgeMap for ${projectId} is pending rebuild; modification workflow blocked`,
          projectId,
        );
      }
    }

    if (repo.dirty) {
      if (taskCtx.dirtyBaselineApprovedBy === null) {
        throw new ForgeMapStaleError(
          `target repo for ${projectId} has uncommitted changes; task start blocked (no dirty-baseline approval)`,
          projectId,
          true,
        );
      }
      notes.push(
        `dirty baseline: maintainer ${taskCtx.dirtyBaselineApprovedBy} approved running on uncommitted changes (indexed_dirty: true)`,
      );
    } else if (repo.commit !== source.indexedCommit) {
      // HEAD moved but clean: a partial refresh is planned, then proceed.
      notes.push(
        `refresh planned: indexed_commit ${source.indexedCommit} != HEAD ${repo.commit} (clean); proceeding`,
      );
    }

    return { notes };
  }

  private async writeStaging(
    worktreePath: string,
    record: ForgeMapRecord,
    selection: SelectedDoc[],
    verdict: StagingVerdict,
  ): Promise<void> {
    const contextRel = path.join('.forgeroom', 'context');
    const docsDirRel = path.join(contextRel, 'docs');
    // safeJoinInsideRoot validates each staged path stays inside the worktree.
    const docsDir = safeJoinInsideRoot(worktreePath, docsDirRel);
    await mkdir(docsDir, { recursive: true });

    // Snapshot-copy each selected doc under context/docs/<relPath>. The doc
    // relPath must stay inside docs/ (not just inside the worktree), so a
    // `../`-laden relPath cannot land elsewhere in `.forgeroom/`.
    for (const { doc } of selection) {
      const stagedAbs = safeJoinInsideRoot(docsDir, doc.relPath);
      if (isSecretPath(stagedAbs)) {
        throw new OrchestratorError(
          'agent_error',
          `refusing to stage secret-like ForgeMap doc: ${doc.relPath}`,
        );
      }
      await mkdir(path.dirname(stagedAbs), { recursive: true });
      await writeFile(stagedAbs, doc.content);
    }

    // target-profile.md = the project-profile snapshot (ADR-014 redefinition).
    const profile = selection.find((s) => s.doc.purpose === 'project-profile');
    if (profile !== undefined) {
      await writeFile(safeJoinInsideRoot(worktreePath, path.join(contextRel, 'target-profile.md')), profile.doc.content);
    }

    // selected-forgemap.md = the manifest (readable paths, summaries, log,
    // warnings). It never inlines doc content (forgemap.md staging rules).
    const manifestRel = path.join(contextRel, 'selected-forgemap.md');
    const manifest = renderManifest(record, selection, verdict, this.now());
    await writeFile(safeJoinInsideRoot(worktreePath, manifestRel), manifest);
  }
}

interface StagingVerdict {
  notes: string[];
}

// ---------------------------------------------------------------------------
// Selection logic (deterministic MVP — forgemap.md "Structured index")
// ---------------------------------------------------------------------------

/**
 * Select the per-purpose subset for a task. MVP rules:
 *   - project-profile is always the baseline.
 *   - referenced changed paths match a doc's relPath -> include.
 *   - title/description tokens that hit a doc keyword -> include (matched_symbol).
 *   - explicit 1-hop depends_on from an included doc -> include.
 * No ranking, no semantic retrieval, no >1-hop expansion (Phase 2).
 */
function selectDocs(docs: ForgeMapDoc[], taskCtx: StageTaskContext): SelectedDoc[] {
  const byId = new Map<string, ForgeMapDoc>();
  for (const doc of docs) {
    byId.set(docId(doc), doc);
  }

  const selected = new Map<string, SelectedDoc>();
  const include = (doc: ForgeMapDoc, reason: ContextExpansionReason, signal: string): void => {
    const key = docId(doc);
    if (!selected.has(key)) {
      selected.set(key, { doc, reason, signal });
    }
  };

  // Baseline: the project profile is always staged.
  for (const doc of docs) {
    if (doc.purpose === 'project-profile') {
      include(doc, 'project_profile_baseline', 'always');
    }
  }

  const tokens = tokenize(`${taskCtx.title} ${taskCtx.description}`);
  for (const doc of docs) {
    // referenced_path: a changed path that matches this doc's source-relative path.
    const referenced = taskCtx.changedPaths.find((p) => normalize(p) === normalize(doc.relPath));
    if (referenced !== undefined) {
      include(doc, 'referenced_path', referenced);
      continue;
    }
    // matched_symbol: a task token hits one of the doc's keywords.
    const hit = doc.keywords.find((kw) => tokens.has(normalize(kw)));
    if (hit !== undefined) {
      include(doc, 'matched_symbol', hit);
    }
  }

  // 1-hop depends_on expansion from the directly-selected docs only.
  for (const { doc } of [...selected.values()]) {
    for (const depId of doc.dependsOn ?? []) {
      const dep = byId.get(depId);
      if (dep !== undefined) {
        include(dep, '1hop_depends_on', `${docId(doc)} -> ${depId}`);
      }
    }
  }

  return [...selected.values()];
}

function docId(doc: ForgeMapDoc): string {
  return doc.id ?? doc.relPath;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 0),
  );
}

function normalize(value: string): string {
  return value.toLowerCase();
}

// ---------------------------------------------------------------------------
// Manifest rendering
// ---------------------------------------------------------------------------

function renderManifest(
  record: ForgeMapRecord,
  selection: SelectedDoc[],
  verdict: StagingVerdict,
  now: Date,
): string {
  const lines: string[] = [
    '# Selected ForgeMap',
    '',
    `- Project: ${record.projectId}`,
    `- Staged at: ${now.toISOString()}`,
    `- indexed_commit: ${record.source.indexedCommit}`,
    `- indexed_dirty: ${record.source.indexedDirty}`,
    '',
  ];

  if (verdict.notes.length > 0) {
    lines.push('## Source warnings', '');
    for (const note of verdict.notes) {
      lines.push(`- ${note}`);
    }
    lines.push('');
  }

  lines.push('## Selection Log', '', '| Included | Reason | Signal |', '|---|---|---|');
  for (const { doc, reason, signal } of selection) {
    lines.push(`| docs/${doc.relPath} | ${reason} | ${signal} |`);
  }
  lines.push('');

  lines.push('## Included documents', '');
  for (const { doc } of selection) {
    lines.push(`- docs/${doc.relPath} — ${doc.summary}`);
  }
  lines.push('');

  return lines.join('\n');
}
