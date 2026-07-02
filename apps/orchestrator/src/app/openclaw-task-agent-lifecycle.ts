/**
 * OpenClaw-backed {@link TaskAgentLifecycle} (ADR-030).
 *
 * Bridges the provider-neutral lifecycle the pipeline engine drives onto the
 * OpenClaw `agents add`/`agents delete` IPC. The OpenClaw agent name is derived
 * deterministically from the task id via {@link ephemeralAgentIdForTask} — the
 * SAME derivation the step collaborator uses to set `runtimeSession.providerAgentId`
 * — so a run is created as, and driven through, exactly one agent.
 *
 * ADR-030 binds the agent's workspace to the task worktree, so OpenClaw writes
 * its per-agent bootstrap/persona artifacts (`SOUL.md` … `.openclaw/`) into the
 * worktree root. Left alone, `git add --all` during branch publication would
 * stage them into the task's PR (#124). `ensure` therefore also excludes those
 * artifacts from the worktree (local `info/exclude`, never a committed
 * `.gitignore`) right after creating the agent. The denylist is OpenClaw-specific
 * and stays here; the exclude mechanism is provider-neutral (see
 * {@link WorktreeExcludeWriter}) so the generic commit path never learns OpenClaw
 * file names.
 *
 * `child_process` stays in the IPC adapter (`openclaw-ipc.ts`); this only maps
 * task ids to agent ids and threads the gateway endpoint/token.
 */
import { ephemeralAgentIdForTask, type TaskAgentLifecycle } from '../core/agent-runtime/task-agent-lifecycle.js';
import type { OpenClawIpcClient } from './openclaw-provider.js';

/**
 * OpenClaw runtime/persona artifacts written into the workspace (= worktree)
 * root on agent bootstrap. Excluded from the task commit so agent-produced PRs
 * carry only the deliverable (#124, ADR-030). `.openclaw/` trailing slash keeps
 * the whole state directory out.
 */
export const OPENCLAW_ARTIFACT_EXCLUDES = [
  '.openclaw/',
  'SOUL.md',
  'IDENTITY.md',
  'TOOLS.md',
  'USER.md',
  'HEARTBEAT.md',
] as const;

/** Provider-neutral seam for adding local-only ignore rules to a worktree. */
export interface WorktreeExcludeWriter {
  excludeFromWorktree(input: { cwd: string; patterns: string[] }): Promise<void>;
}

export interface OpenClawTaskAgentLifecycleDeps {
  client: OpenClawIpcClient;
  git: WorktreeExcludeWriter;
  endpoint: string;
  token: string;
}

export class OpenClawTaskAgentLifecycle implements TaskAgentLifecycle {
  constructor(private readonly deps: OpenClawTaskAgentLifecycleDeps) {}

  async ensure(req: { taskId: string; workspace: string }): Promise<void> {
    await this.deps.client.addAgent({
      endpoint: this.deps.endpoint,
      token: this.deps.token,
      agentId: ephemeralAgentIdForTask(req.taskId),
      workspace: req.workspace,
    });
    await this.deps.git.excludeFromWorktree({
      cwd: req.workspace,
      patterns: [...OPENCLAW_ARTIFACT_EXCLUDES],
    });
  }

  async remove(req: { taskId: string }): Promise<void> {
    await this.deps.client.deleteAgent({
      endpoint: this.deps.endpoint,
      token: this.deps.token,
      agentId: ephemeralAgentIdForTask(req.taskId),
    });
  }
}
