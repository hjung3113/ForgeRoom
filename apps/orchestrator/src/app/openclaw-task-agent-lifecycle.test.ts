import { describe, expect, it } from 'vitest';

import type {
  OpenClawAgentAddRequest,
  OpenClawAgentDeleteRequest,
  OpenClawIpcClient,
} from './openclaw-provider.js';
import {
  OPENCLAW_ARTIFACT_EXCLUDES,
  OpenClawTaskAgentLifecycle,
  type WorktreeExcludeWriter,
} from './openclaw-task-agent-lifecycle.js';

class RecordingIpc implements Partial<OpenClawIpcClient> {
  addRequests: OpenClawAgentAddRequest[] = [];
  deleteRequests: OpenClawAgentDeleteRequest[] = [];
  log: string[] = [];

  addAgent(request: OpenClawAgentAddRequest): Promise<void> {
    this.addRequests.push(request);
    this.log.push('add');
    return Promise.resolve();
  }

  deleteAgent(request: OpenClawAgentDeleteRequest): Promise<void> {
    this.deleteRequests.push(request);
    return Promise.resolve();
  }
}

class RecordingExcludeWriter implements WorktreeExcludeWriter {
  calls: Array<{ cwd: string; patterns: string[] }> = [];
  constructor(private readonly log?: string[]) {}

  excludeFromWorktree(input: { cwd: string; patterns: string[] }): Promise<void> {
    this.calls.push(input);
    this.log?.push('exclude');
    return Promise.resolve();
  }
}

function lifecycle(): {
  client: RecordingIpc;
  git: RecordingExcludeWriter;
  sut: OpenClawTaskAgentLifecycle;
} {
  const client = new RecordingIpc();
  const git = new RecordingExcludeWriter(client.log);
  const sut = new OpenClawTaskAgentLifecycle({
    client: client as unknown as OpenClawIpcClient,
    git,
    endpoint: 'http://127.0.0.1:18789',
    token: 'tok',
  });
  return { client, git, sut };
}

describe('OpenClawTaskAgentLifecycle', () => {
  it('ensure creates the deterministic per-task agent bound to the worktree', async () => {
    const { client, sut } = lifecycle();
    await sut.ensure({ taskId: 'task-1', workspace: '/wt/task-1' });
    expect(client.addRequests).toEqual([
      { endpoint: 'http://127.0.0.1:18789', token: 'tok', agentId: 'fr-task-1', workspace: '/wt/task-1' },
    ]);
  });

  it('ensure excludes OpenClaw bootstrap artifacts from the worktree after creating the agent', async () => {
    const { client, git, sut } = lifecycle();
    await sut.ensure({ taskId: 'task-1', workspace: '/wt/task-1' });
    // The agent must exist (persona files bootstrapped) before / independent of the
    // exclude write; both run so the commit never stages the artifacts.
    expect(client.log).toEqual(['add', 'exclude']);
    expect(git.calls).toEqual([{ cwd: '/wt/task-1', patterns: OPENCLAW_ARTIFACT_EXCLUDES }]);
  });

  it('exposes the OpenClaw runtime artifacts as the exclude denylist', () => {
    expect(OPENCLAW_ARTIFACT_EXCLUDES).toEqual([
      '.openclaw/',
      'SOUL.md',
      'IDENTITY.md',
      'TOOLS.md',
      'USER.md',
      'HEARTBEAT.md',
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
