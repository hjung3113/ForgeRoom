import type { GateProfile } from '../engine/runtime-profile-compiler.js';

export interface GateDecision {
  allowed: boolean;
  reason?: GateDenialReason;
  category?: GateDenialCategory;
}

export type GateDenialCategory = 'command' | 'filesystem' | 'workflow' | 'secret' | 'permission';

export type GateDenialReason =
  | 'destructive_git'
  | 'destructive_filesystem'
  | 'download_execute'
  | 'file_outside_worktree'
  | 'migration'
  | 'protected_branch'
  | 'secret_path'
  | 'worktree_inside_project'
  | 'worktree_root_not_allowed'
  | 'shell_disabled'
  | 'filesystem_read_only';

/**
 * Subset of GateProfile fields ApprovalGate currently enforces. Other fields
 * (network, tools.allow/deny) are produced by the compiler but enforcement is
 * deferred to follow-up work — see runtime-profile-compiler.ts header comment.
 */
export interface EnforcedProfile {
  shell: GateProfile['shell'];
  filesystem: GateProfile['filesystem'];
}

const OUTPUT_CHANNEL_PREFIXES = ['.forgeroom/outputs/', '.forgeroom/logs/'] as const;

export interface WorktreeCreationSafetyInput {
  branch: string;
  worktreePath: string;
  allowedWorktreeRoots: string[];
}

export class ApprovalGate {
  /**
   * Project-shell command admission. `profile` (optional) carries per-step
   * harness-derived permissions; when its `shell` field is `disabled`, every
   * project-shell command is denied (planning/review harness invariant).
   *
   * The synthetic agent-execution check ({@link checkAgentExecution}) is
   * EXEMPT from `shell.disabled` — those harnesses still need to write their
   * own output file.
   */
  checkCommand(command: string, _cwd: string, profile?: EnforcedProfile): GateDecision {
    if (profile?.shell === 'disabled') {
      return deny('permission', 'shell_disabled');
    }

    const normalizedCommand = normalizeCommand(command);
    const lowerCommand = normalizedCommand.toLowerCase();

    if (isDestructiveGitCommand(lowerCommand)) {
      return deny('command', 'destructive_git');
    }

    if (isRootRemoveCommand(lowerCommand)) {
      return deny('command', 'destructive_filesystem');
    }

    if (containsSecretPath(normalizedCommand)) {
      return deny('secret', 'secret_path');
    }

    if (isMigrationCommand(lowerCommand)) {
      return deny('command', 'migration');
    }

    if (isDownloadExecuteCommand(lowerCommand)) {
      return deny('command', 'download_execute');
    }

    return allow();
  }

  /**
   * Agent-execution synthetic (`read <prompt> && write <output>`) admission.
   * NEVER subject to `profile.shell` — agents must always be able to emit
   * their declared output file. `profile.filesystem === 'read_only'` is
   * enforced against the output path: writes outside `.forgeroom/outputs/`
   * and `.forgeroom/logs/` are denied.
   */
  checkAgentExecution(
    promptPath: string,
    outputPath: string,
    worktreePath: string,
    profile?: EnforcedProfile,
  ): GateDecision {
    const normalizedWorktreePath = normalizeAbsolutePath(worktreePath);
    const normalizedOutput = normalizePathAgainstRoot(outputPath, normalizedWorktreePath);

    if (!isInsideRoot(normalizedOutput, normalizedWorktreePath)) {
      return deny('filesystem', 'file_outside_worktree');
    }
    if (isSecretPath(normalizedOutput)) {
      return deny('secret', 'secret_path');
    }

    if (profile?.filesystem === 'read_only') {
      const relative = normalizedOutput.slice(normalizedWorktreePath.length + 1);
      const inOutputChannel = OUTPUT_CHANNEL_PREFIXES.some((prefix) => relative.startsWith(prefix));
      if (!inOutputChannel) {
        return deny('permission', 'filesystem_read_only');
      }
    }

    void promptPath;
    return allow();
  }

  checkFileWrite(filePath: string, worktreePath: string): GateDecision {
    const normalizedWorktreePath = normalizeAbsolutePath(worktreePath);
    const normalizedFilePath = normalizePathAgainstRoot(filePath, normalizedWorktreePath);

    if (!isInsideRoot(normalizedFilePath, normalizedWorktreePath)) {
      return deny('filesystem', 'file_outside_worktree');
    }

    if (isSecretPath(normalizedFilePath)) {
      return deny('secret', 'secret_path');
    }

    return allow();
  }

  checkWorktreeCreation(input: WorktreeCreationSafetyInput, project: ProjectMeta): GateDecision {
    if (isProtectedBranch(input.branch, project.default_branch)) {
      return deny('workflow', 'protected_branch');
    }

    const normalizedWorktreePath = normalizeAbsolutePath(input.worktreePath);
    const projectPath = normalizeAbsolutePath(project.path);

    if (isInsideRoot(normalizedWorktreePath, projectPath)) {
      return deny('workflow', 'worktree_inside_project');
    }

    const allowedRoots = input.allowedWorktreeRoots;
    if (
      allowedRoots.length === 0 ||
      !allowedRoots.some((root) => isInsideRoot(normalizedWorktreePath, normalizeAbsolutePath(root)))
    ) {
      return deny('workflow', 'worktree_root_not_allowed');
    }

    if (isSecretPath(normalizedWorktreePath)) {
      return deny('secret', 'secret_path');
    }

    return allow();
  }

  checkWorkflow(_workflow: ParsedWorkflow, _project: ProjectMeta): GateDecision {
    return allow();
  }
}

function allow(): GateDecision {
  return { allowed: true };
}

function deny(category: GateDenialCategory, reason: GateDenialReason): GateDecision {
  return { allowed: false, category, reason };
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

function isDestructiveGitCommand(command: string): boolean {
  return (
    /\bgit push\b/.test(command) &&
      (/(?:^|\s)--force(?:-with-lease)?(?:=|\s|$)/.test(command) ||
        /(?:^|\s)--delete(?:\s|$)/.test(command)) ||
    /\bgit reset\b/.test(command) && /\s--hard(?:\s|$)/.test(command) && /\borigin\//.test(command) ||
    /\bgit branch\b/.test(command) &&
      (/(?:^|\s)-d(?:\s|$)/.test(command) ||
        /(?:^|\s)--delete(?:\s|$)/.test(command))
  );
}

function isRootRemoveCommand(command: string): boolean {
  return /\brm\b(?=.*(?:^|\s)-[a-z-]*r[a-z-]*)(?=.*(?:^|\s)-[a-z-]*f[a-z-]*).*(?:^|\s)(?:--\s+)?\/(?:\s|$)/.test(
    command,
  );
}

function isMigrationCommand(command: string): boolean {
  return command.includes('migrate') || /\bdb reset\b/.test(command);
}

function isDownloadExecuteCommand(command: string): boolean {
  return /\b(?:curl|wget)\b.*\|\s*(?:\/(?:usr\/)?bin\/)?(?:sh|bash)(?:\s|$)/.test(command);
}

function containsSecretPath(command: string): boolean {
  return tokenizeCommand(command).some(isSecretPath);
}

function tokenizeCommand(command: string): string[] {
  return command
    .split(/[\s'"`|;&<>]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function isProtectedBranch(branch: string, defaultBranch: string): boolean {
  return branch === 'main' || branch === 'default_branch' || branch === defaultBranch;
}

function isSecretPath(filePath: string): boolean {
  const normalized = filePath.replaceAll('\\', '/');
  const basename = normalized.split('/').at(-1) ?? normalized;

  return (
    basename === '.env' ||
    basename === '.env.local' ||
    basename === 'id_rsa' ||
    basename === 'id_dsa' ||
    basename === 'id_ecdsa' ||
    basename === 'id_ed25519' ||
    basename.endsWith('.pem')
  );
}

function normalizePathAgainstRoot(filePath: string, rootPath: string): string {
  if (isAbsolutePath(filePath)) {
    return normalizeAbsolutePath(filePath);
  }

  return normalizeAbsolutePath(`${rootPath}/${filePath}`);
}

function normalizeAbsolutePath(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/');
  const absolutePrefix = isAbsolutePath(normalized) ? '/' : '';
  const parts: string[] = [];

  for (const part of normalized.split('/')) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }

  const result = `${absolutePrefix}${parts.join('/')}`;
  if (result.length > 1 && result.endsWith('/')) {
    return result.slice(0, -1);
  }

  return result;
}

function isAbsolutePath(filePath: string): boolean {
  return filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath);
}

function isInsideRoot(targetPath: string, rootPath: string): boolean {
  const normalizedTarget = normalizeAbsolutePath(targetPath);
  const normalizedRoot = normalizeAbsolutePath(rootPath);

  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
}
import type { ProjectMeta } from '../registries/project-registry.js';
import type { ParsedWorkflow } from '../registries/workflow-registry.js';
