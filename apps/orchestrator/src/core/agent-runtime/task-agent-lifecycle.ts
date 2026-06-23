/**
 * Per-task ephemeral OpenClaw agent lifecycle (ADR-030).
 *
 * The OpenClaw `agent` CLI has no `--cwd`/`--workspace`: every run executes in
 * the global `agents.defaults.workspace` ($HOME). ForgeRoom runs each task in a
 * git worktree whose `.forgeroom/context/*` the plan step READS and whose source
 * the implement step WRITES. To bind a run to its worktree, the engine creates a
 * dedicated OpenClaw agent per task (`openclaw agents add --workspace <worktree>`)
 * and drives every step/retry through it (`--agent <id>`), never falling back to
 * the global `main` agent. The agent is deleted when the task settles.
 *
 * This module owns the provider-neutral seam + the deterministic name derivation.
 * The OpenClaw-specific `agents add`/`agents delete` subprocess calls live in the
 * `app/` adapter (core must not touch `child_process`); both the adapter and the
 * step collaborator derive the same id from {@link ephemeralAgentIdForTask} so the
 * agent a run is CREATED as is exactly the agent its steps are DRIVEN as.
 */

/** Prefix every per-task ephemeral agent shares (boot-time orphan GC matches it). */
const EPHEMERAL_AGENT_PREFIX = 'fr-';

/**
 * Deterministic OpenClaw agent id for a task. Derived purely from the task id so
 * a resumed/retried run resolves the SAME agent without persisting the name
 * separately, and never leaks to the global `main` agent (codex 88).
 */
export function ephemeralAgentIdForTask(taskId: string): string {
  return `${EPHEMERAL_AGENT_PREFIX}${taskId}`;
}

/**
 * Provider-neutral lifecycle the pipeline engine drives around a task's run.
 * Implemented in `app/` over the OpenClaw CLI (ADR-012 keeps OpenClaw the MVP
 * provider). `ensure` is idempotent (safe to call again on resume/recovery);
 * `remove` is idempotent (a missing agent is success) and best-effort at the
 * call site (a delete failure must never alter the task's terminal outcome).
 */
export interface TaskAgentLifecycle {
  /** Create the task's agent bound to its worktree, if it does not already exist. */
  ensure(req: { taskId: string; workspace: string }): Promise<void>;
  /** Delete the task's agent (and prune its workspace/state). */
  remove(req: { taskId: string }): Promise<void>;
}
