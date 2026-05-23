import type { Task } from './types.js';

export interface WorktreeHandle {
  path: string;
  branch: string;
}

export interface WorktreeGitClient {
  worktreeExists(worktreePath: string): Promise<boolean>;
  createWorktree(input: { path: string; branch: string }): Promise<void>;
}

export interface WorktreeFileSystem {
  ensureDir(dirPath: string): Promise<void>;
  writeFileIfMissing(filePath: string, content: string): Promise<void>;
}

export interface WorktreeManagerDependencies {
  git: WorktreeGitClient;
  fileSystem: WorktreeFileSystem;
}

const FORGEROOM_DIRECTORIES = [
  '.forgeroom',
  '.forgeroom/context',
  '.forgeroom/context/docs',
  '.forgeroom/prompts',
  '.forgeroom/outputs',
  '.forgeroom/diffs',
  '.forgeroom/logs',
] as const;

const BASE_CONTEXT_FILES = ['summary.md', 'workflow.md', 'feedback.md'] as const;

export class WorktreeManager {
  private readonly git: WorktreeGitClient;
  private readonly fileSystem: WorktreeFileSystem;

  constructor(dependencies: WorktreeManagerDependencies) {
    this.git = dependencies.git;
    this.fileSystem = dependencies.fileSystem;
  }

  async create(task: Task): Promise<WorktreeHandle> {
    const worktreePath = normalizeWorktreePath(task.worktree_path);

    if (!(await this.git.worktreeExists(worktreePath))) {
      await this.git.createWorktree({ path: worktreePath, branch: task.branch_name });
    }

    await this.bootstrapForgeroomDir(worktreePath, task);

    return {
      path: worktreePath,
      branch: task.branch_name,
    };
  }

  async ensureForgeroomDir(worktreePath: string): Promise<void> {
    await this.bootstrapForgeroomDir(worktreePath);
  }

  private async bootstrapForgeroomDir(worktreePath: string, task?: Task): Promise<void> {
    const normalizedWorktreePath = normalizeWorktreePath(worktreePath);

    for (const directory of FORGEROOM_DIRECTORIES) {
      await this.fileSystem.ensureDir(joinWorktreePath(normalizedWorktreePath, directory));
    }

    if (task !== undefined) {
      await this.fileSystem.writeFileIfMissing(
        joinWorktreePath(normalizedWorktreePath, '.forgeroom/context/task.md'),
        taskContextFileContent(task),
      );
    }

    for (const fileName of BASE_CONTEXT_FILES) {
      await this.fileSystem.writeFileIfMissing(
        joinWorktreePath(normalizedWorktreePath, `.forgeroom/context/${fileName}`),
        baseContextFileContent(fileName),
      );
    }
  }
}

function taskContextFileContent(task: Task): string {
  return [
    '# Task',
    '',
    `- ID: ${task.id}`,
    `- Project: ${task.project_id}`,
    `- Workflow: ${task.workflow_id}`,
    `- Branch: ${task.branch_name}`,
    '',
    `## ${task.title}`,
    '',
    task.description,
    '',
  ].join('\n');
}

function baseContextFileContent(fileName: (typeof BASE_CONTEXT_FILES)[number]): string {
  if (fileName === 'summary.md') {
    return '# Summary\n';
  }

  if (fileName === 'workflow.md') {
    return '# Workflow\n';
  }

  return '# User Feedback\n';
}

function normalizeWorktreePath(worktreePath: string): string {
  return worktreePath.replace(/\/+$/, '');
}

function joinWorktreePath(worktreePath: string, relativePath: string): string {
  return `${worktreePath}/${relativePath}`;
}
