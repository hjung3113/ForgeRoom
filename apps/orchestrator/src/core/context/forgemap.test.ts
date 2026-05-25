import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ForgeMapStaleError,
  ForgeMapPendingRebuildError,
  ForgeMapStagerImpl,
  type ForgeMapRecord,
  type ForgeMapDoc,
  type ForgeMapStore,
  type RepoStateProbe,
  type StageTaskContext,
  type TaskContextLookup,
} from './forgemap.js';
import type { ForgeMapStager } from '../engine/pipeline-engine.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const PROJECT_ID = 'proj-1';

function makeDoc(overrides: Partial<ForgeMapDoc> = {}): ForgeMapDoc {
  return {
    purpose: 'project-profile',
    relPath: 'project-profile.md',
    content: '# Project Profile\nA target project.\n',
    summary: 'project overview',
    keywords: ['profile'],
    ...overrides,
  };
}

function makeRecord(overrides: Partial<ForgeMapRecord> = {}): ForgeMapRecord {
  return {
    projectId: PROJECT_ID,
    source: {
      repoPath: '/abs/repo',
      defaultBranch: 'main',
      indexedCommit: 'commit-a',
      indexedDirty: false,
      indexedAt: '2026-05-22T00:00:00.000Z',
    },
    docs: [
      makeDoc(),
      makeDoc({
        purpose: 'architecture-map',
        relPath: 'architecture-map.md',
        content: '# Architecture\nRuntime boundaries.\n',
        summary: 'runtime boundaries',
        keywords: ['architecture', 'runtime'],
      }),
      makeDoc({
        purpose: 'testing-map',
        relPath: 'testing-map.md',
        content: '# Testing\nVitest unit tests.\n',
        summary: 'testing strategy',
        keywords: ['test', 'vitest'],
      }),
    ],
    ...overrides,
  };
}

class FakeStore implements ForgeMapStore {
  built = 0;
  constructor(private record: ForgeMapRecord | null) {}
  async get(projectId: string): Promise<ForgeMapRecord | null> {
    return Promise.resolve(
      this.record !== null && this.record.projectId === projectId ? this.record : null,
    );
  }
  build(projectId: string): Promise<ForgeMapRecord> {
    this.built += 1;
    this.record = makeRecord({ projectId });
    return Promise.resolve(this.record);
  }
}

class FakeRepoProbe implements RepoStateProbe {
  constructor(private state: { commit: string; dirty: boolean }) {}
  head(_repoPath: string): Promise<{ commit: string; dirty: boolean }> {
    return Promise.resolve(this.state);
  }
}

function makeTaskCtx(overrides: Partial<StageTaskContext> = {}): StageTaskContext {
  return {
    title: 'Improve architecture and runtime boundaries',
    description: 'Refactor the runtime layer.',
    worktreeKind: 'modifies',
    dirtyBaselineApprovedBy: null,
    pendingRebuildApprovedBy: null,
    changedPaths: [],
    ...overrides,
  };
}

class FakeTaskLookup implements TaskContextLookup {
  constructor(private ctx: StageTaskContext) {}
  forTask(_taskId: string): Promise<StageTaskContext> {
    return Promise.resolve(this.ctx);
  }
}

// ---------------------------------------------------------------------------

describe('ForgeMapStagerImpl', () => {
  let worktree: string;

  beforeEach(async () => {
    worktree = await mkdtemp(path.join(tmpdir(), 'forgemap-test-'));
    // The seam runs after WorktreeManager bootstrap; mirror its skeleton.
    await mkdir(path.join(worktree, '.forgeroom', 'context', 'docs'), { recursive: true });
  });

  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true });
  });

  function stage(input: {
    record: ForgeMapRecord | null;
    repo: { commit: string; dirty: boolean };
    ctx?: Partial<StageTaskContext>;
  }) {
    const store = new FakeStore(input.record);
    const stager = new ForgeMapStagerImpl({
      store,
      repoProbe: new FakeRepoProbe(input.repo),
      taskLookup: new FakeTaskLookup(makeTaskCtx(input.ctx)),
      now: () => new Date('2026-05-23T00:00:00.000Z'),
    });
    return { store, stager };
  }

  async function readManifest(): Promise<string> {
    return readFile(path.join(worktree, '.forgeroom', 'context', 'selected-forgemap.md'), 'utf8');
  }

  it('conforms to the pipeline-engine ForgeMapStager seam', () => {
    const { stager } = stage({ record: makeRecord(), repo: { commit: 'commit-a', dirty: false } });
    // Structural assignability check: the impl IS a ForgeMapStager.
    const seam: ForgeMapStager = stager;
    expect(typeof seam.stage).toBe('function');
  });

  it('stages per-purpose docs as snapshot copies (not one giant summary)', async () => {
    const { stager } = stage({ record: makeRecord(), repo: { commit: 'commit-a', dirty: false } });

    await stager.stage({ taskId: 't1', worktreePath: worktree, projectId: PROJECT_ID });

    // architecture-map should be selected (title mentions "architecture"); each
    // selected doc is its own file under docs/, not merged into one summary.
    const arch = await readFile(
      path.join(worktree, '.forgeroom', 'context', 'docs', 'architecture-map.md'),
      'utf8',
    );
    expect(arch).toContain('Runtime boundaries');

    // project-profile is always included and also surfaced as target-profile.md.
    const profile = await readFile(
      path.join(worktree, '.forgeroom', 'context', 'target-profile.md'),
      'utf8',
    );
    expect(profile).toContain('Project Profile');

    const manifest = await readManifest();
    expect(manifest).toContain('## Selection Log');
    expect(manifest).toContain('architecture-map.md');
    expect(manifest).toContain('matched_symbol');
  });

  it('builds the map when the store has none, then stages it', async () => {
    const { store, stager } = stage({ record: null, repo: { commit: 'commit-a', dirty: false } });

    await stager.stage({ taskId: 't1', worktreePath: worktree, projectId: PROJECT_ID });

    expect(store.built).toBe(1);
    const manifest = await readManifest();
    expect(manifest).toContain('project-profile.md');
  });

  it('uses the existing map when indexed_commit == HEAD and no dirty', async () => {
    const { store, stager } = stage({ record: makeRecord(), repo: { commit: 'commit-a', dirty: false } });

    await stager.stage({ taskId: 't1', worktreePath: worktree, projectId: PROJECT_ID });

    expect(store.built).toBe(0);
  });

  it('blocks task start by default when the target repo is dirty', async () => {
    const { stager } = stage({ record: makeRecord(), repo: { commit: 'commit-a', dirty: true } });

    await expect(
      stager.stage({ taskId: 't1', worktreePath: worktree, projectId: PROJECT_ID }),
    ).rejects.toBeInstanceOf(ForgeMapStaleError);
  });

  it('proceeds on a dirty baseline when a maintainer approved, recording it', async () => {
    const { stager } = stage({
      record: makeRecord(),
      repo: { commit: 'commit-a', dirty: true },
      ctx: { dirtyBaselineApprovedBy: 'maintainer-1' },
    });

    await stager.stage({ taskId: 't1', worktreePath: worktree, projectId: PROJECT_ID });

    const manifest = await readManifest();
    expect(manifest).toContain('dirty baseline');
    expect(manifest).toContain('maintainer-1');
    expect(manifest).toContain('indexed_dirty: true');
  });

  it('proceeds when HEAD moved but repo is clean (refresh-then-proceed)', async () => {
    const { stager } = stage({ record: makeRecord(), repo: { commit: 'commit-b', dirty: false } });

    await stager.stage({ taskId: 't1', worktreePath: worktree, projectId: PROJECT_ID });

    const manifest = await readManifest();
    expect(manifest).toContain('refresh');
  });

  it('blocks a modification workflow when the map is pending rebuild', async () => {
    const record = makeRecord({
      source: {
        repoPath: '/abs/repo',
        defaultBranch: 'main',
        indexedCommit: 'commit-a',
        indexedDirty: false,
        indexedAt: '2026-05-22T00:00:00.000Z',
        pendingRebuild: true,
      },
    });
    const { stager } = stage({ record, repo: { commit: 'commit-a', dirty: false } });

    await expect(
      stager.stage({ taskId: 't1', worktreePath: worktree, projectId: PROJECT_ID }),
    ).rejects.toBeInstanceOf(ForgeMapPendingRebuildError);
  });

  it('allows a read-only workflow on a pending-rebuild map with a warning', async () => {
    const record = makeRecord({
      source: {
        repoPath: '/abs/repo',
        defaultBranch: 'main',
        indexedCommit: 'commit-a',
        indexedDirty: false,
        indexedAt: '2026-05-22T00:00:00.000Z',
        pendingRebuild: true,
      },
    });
    const { stager } = stage({
      record,
      repo: { commit: 'commit-a', dirty: false },
      ctx: { worktreeKind: 'read_only' },
    });

    await stager.stage({ taskId: 't1', worktreePath: worktree, projectId: PROJECT_ID });

    const manifest = await readManifest();
    expect(manifest).toContain('pending rebuild');
  });

  it('allows a pending-rebuild modification workflow when a maintainer approved', async () => {
    const record = makeRecord({
      source: {
        repoPath: '/abs/repo',
        defaultBranch: 'main',
        indexedCommit: 'commit-a',
        indexedDirty: false,
        indexedAt: '2026-05-22T00:00:00.000Z',
        pendingRebuild: true,
      },
    });
    const { stager } = stage({
      record,
      repo: { commit: 'commit-a', dirty: false },
      ctx: { pendingRebuildApprovedBy: 'maintainer-2' },
    });

    await stager.stage({ taskId: 't1', worktreePath: worktree, projectId: PROJECT_ID });

    const manifest = await readManifest();
    expect(manifest).toContain('pending rebuild');
    expect(manifest).toContain('maintainer-2');
  });

  it('records a 1-hop depends_on inclusion reason in the selection log', async () => {
    const record = makeRecord({
      docs: [
        makeDoc(),
        makeDoc({
          purpose: 'module-index',
          relPath: 'module-index.md',
          content: '# Modules\nGateway.\n',
          summary: 'modules',
          keywords: ['gateway'],
          dependsOn: ['reporter'],
        }),
        makeDoc({
          purpose: 'risk-map',
          relPath: 'reporter.md',
          content: '# Reporter\n',
          summary: 'reporter',
          keywords: ['reporter'],
          id: 'reporter',
        }),
      ],
    });
    const { stager } = stage({
      record,
      repo: { commit: 'commit-a', dirty: false },
      ctx: { title: 'fix gateway', description: 'gateway bug' },
    });

    await stager.stage({ taskId: 't1', worktreePath: worktree, projectId: PROJECT_ID });

    const manifest = await readManifest();
    expect(manifest).toContain('1hop_depends_on');
    expect(manifest).toContain('reporter.md');
  });

  it('refuses to escape the worktree when a doc relPath is unsafe', async () => {
    const record = makeRecord({
      docs: [makeDoc({ relPath: '../escape.md' })],
    });
    const { stager } = stage({ record, repo: { commit: 'commit-a', dirty: false } });

    await expect(
      stager.stage({ taskId: 't1', worktreePath: worktree, projectId: PROJECT_ID }),
    ).rejects.toThrow();
  });
});
