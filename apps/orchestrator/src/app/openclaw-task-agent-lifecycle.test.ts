import { describe, expect, it } from 'vitest';

import type {
  OpenClawAgentAddRequest,
  OpenClawAgentDeleteRequest,
  OpenClawIpcClient,
} from './openclaw-provider.js';
import { OpenClawTaskAgentLifecycle } from './openclaw-task-agent-lifecycle.js';

class RecordingIpc implements Partial<OpenClawIpcClient> {
  addRequests: OpenClawAgentAddRequest[] = [];
  deleteRequests: OpenClawAgentDeleteRequest[] = [];

  addAgent(request: OpenClawAgentAddRequest): Promise<void> {
    this.addRequests.push(request);
    return Promise.resolve();
  }

  deleteAgent(request: OpenClawAgentDeleteRequest): Promise<void> {
    this.deleteRequests.push(request);
    return Promise.resolve();
  }
}

function lifecycle(): { client: RecordingIpc; sut: OpenClawTaskAgentLifecycle } {
  const client = new RecordingIpc();
  const sut = new OpenClawTaskAgentLifecycle({
    client: client as unknown as OpenClawIpcClient,
    endpoint: 'http://127.0.0.1:18789',
    token: 'tok',
  });
  return { client, sut };
}

describe('OpenClawTaskAgentLifecycle', () => {
  it('ensure creates the deterministic per-task agent bound to the worktree', async () => {
    const { client, sut } = lifecycle();
    await sut.ensure({ taskId: 'task-1', workspace: '/wt/task-1' });
    expect(client.addRequests).toEqual([
      { endpoint: 'http://127.0.0.1:18789', token: 'tok', agentId: 'fr-task-1', workspace: '/wt/task-1' },
    ]);
  });

  it('remove deletes the same deterministic per-task agent', async () => {
    const { client, sut } = lifecycle();
    await sut.remove({ taskId: 'task-1' });
    expect(client.deleteRequests).toEqual([
      { endpoint: 'http://127.0.0.1:18789', token: 'tok', agentId: 'fr-task-1' },
    ]);
  });
});
