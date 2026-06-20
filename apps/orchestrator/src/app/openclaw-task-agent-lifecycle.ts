/**
 * OpenClaw-backed {@link TaskAgentLifecycle} (ADR-030).
 *
 * Bridges the provider-neutral lifecycle the pipeline engine drives onto the
 * OpenClaw `agents add`/`agents delete` IPC. The OpenClaw agent name is derived
 * deterministically from the task id via {@link ephemeralAgentIdForTask} — the
 * SAME derivation the step collaborator uses to set `runtimeSession.providerAgentId`
 * — so a run is created as, and driven through, exactly one agent.
 *
 * `child_process` stays in the IPC adapter (`openclaw-ipc.ts`); this only maps
 * task ids to agent ids and threads the gateway endpoint/token.
 */
import { ephemeralAgentIdForTask, type TaskAgentLifecycle } from '../core/agent-runtime/task-agent-lifecycle.js';
import type { OpenClawIpcClient } from './openclaw-provider.js';

export interface OpenClawTaskAgentLifecycleDeps {
  client: OpenClawIpcClient;
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
  }

  async remove(req: { taskId: string }): Promise<void> {
    await this.deps.client.deleteAgent({
      endpoint: this.deps.endpoint,
      token: this.deps.token,
      agentId: ephemeralAgentIdForTask(req.taskId),
    });
  }
}
