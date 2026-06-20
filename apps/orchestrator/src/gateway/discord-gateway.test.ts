import { describe, it, expect, beforeEach, vi } from 'vitest';

import { DiscordGateway } from './discord-gateway.js';
import type {
  OrchestratorGatewayPort,
  DiscordGatewayConfig,
  ProjectLookup,
} from './discord-gateway.js';
import type { Task, TaskRequest } from '../core/types.js';

// ---------------------------------------------------------------------------
// Fakes — no live Discord, no real engine.
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    project_id: 'proj-a',
    workflow_id: 'default',
    title: 'do the thing',
    description: '',
    status: 'running',
    failure_reason: null,
    source: 'discord-command',
    external_ref: null,
    issue_number: null,
    branch_name: 'forge/task-1',
    worktree_path: '/tmp/wt',
    pr_number: null,
    final_slices: [],
    vars: {},
    mastra_run_id: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

class FakeOrchestrator implements OrchestratorGatewayPort {
  startTask = vi.fn(async (_req: TaskRequest) => 'task-1');
  pauseTask = vi.fn(async (_taskId: string) => {});
  resumeTask = vi.fn(async (_taskId: string) => {});
  cancelTask = vi.fn(async (_taskId: string) => {});
  getTaskStatus = vi.fn(async (_taskId: string): Promise<Task | null> => makeTask());
  listActiveTasks = vi.fn(async (_projectId?: string): Promise<Task[]> => [makeTask()]);
  listRecentTasks = vi.fn(async (_projectId: string, _limit: number): Promise<Task[]> => [makeTask()]);
  listProjectSessions = vi.fn(async (_projectId: string) => [
    { taskId: 'task-1', stepId: 'plan', openclawSessionId: 'oc-1', agentKey: 'fr-planner', role: 'planner' },
  ]);
  listTaskSessions = vi.fn(async (_taskId: string) => [
    { taskId: 'task-1', stepId: 'execute', openclawSessionId: 'oc-2', agentKey: 'fr-impl', role: 'implementer' },
  ]);
  refreshRoomCanvas = vi.fn(async (_projectId: string) => '/canvas/proj-a/index.html');
  askTask = vi.fn(async (_taskId: string, _question: string) => 'the answer');
  recordFeedback = vi.fn(async (_taskId: string, _message: string) => {});
  recordApproval = vi.fn(async (_taskId: string, _approvedBy: string) => {});
}

const projects: Record<string, ProjectLookup> = {
  'proj-a': { id: 'proj-a', default_workflow: 'default', allowed_workflows: ['default', 'review-only'] },
  'proj-b': { id: 'proj-b', default_workflow: 'default', allowed_workflows: ['default'] },
};

function makeConfig(over: Partial<DiscordGatewayConfig> = {}): DiscordGatewayConfig {
  return {
    token: 'fake-token',
    applicationId: 'app-1',
    guildIds: ['guild-1'],
    allowedUserIds: ['user-allowed'],
    lookupProject: (id) => projects[id] ?? null,
    ...over,
  };
}

// Minimal ChatInputCommandInteraction fake.
interface FakeOptions {
  subcommand?: string;
  strings?: Record<string, string | null>;
}

interface ReplyArg {
  content: string;
  ephemeral?: boolean;
}

function makeInteraction(commandName: string, opts: FakeOptions, userId = 'user-allowed') {
  const reply = vi.fn(async (_arg: ReplyArg) => {});
  const interaction = {
    isChatInputCommand: () => true,
    commandName,
    user: { id: userId },
    channelId: 'chan-1',
    options: {
      getSubcommand: () => opts.subcommand ?? '',
      getString: (name: string, _required?: boolean) => opts.strings?.[name] ?? null,
    },
    reply,
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
  };
  return { interaction, reply };
}

describe('DiscordGateway slash command dispatch', () => {
  let orch: FakeOrchestrator;
  let gw: DiscordGateway;

  beforeEach(() => {
    orch = new FakeOrchestrator();
    gw = new DiscordGateway(orch, makeConfig());
  });

  it('builds the seven slash commands', () => {
    const names = gw.buildSlashCommands().map((c) => c.name).sort();
    expect(names).toEqual(['approve', 'ask', 'cancel', 'feedback', 'history', 'pause', 'resume', 'room', 'run', 'stats', 'status']);
  });

  it('registers /run project as optional so project rooms can infer it from the channel', () => {
    const run = gw.buildSlashCommands().find((c) => c.name === 'run')?.toJSON();
    const project = run?.options?.find((option) => option.name === 'project');
    expect(project?.required).toBe(false);
  });

  it('orders required options before optional ones (Discord registration invariant)', () => {
    // Discord rejects registration with APPLICATION_COMMAND_OPTIONS_REQUIRED_INVALID
    // if a required option follows an optional one.
    for (const command of gw.buildSlashCommands()) {
      const options = command.toJSON().options ?? [];
      let seenOptional = false;
      for (const option of options) {
        if (option.required) {
          expect(
            seenOptional,
            `/${command.name}: required option "${option.name}" must precede all optional options`,
          ).toBe(false);
        } else {
          seenOptional = true;
        }
      }
    }
  });

  it('/run builds a valid TaskRequest within allowed_workflows', async () => {
    const { interaction, reply } = makeInteraction('run', {
      strings: { project: 'proj-a', title: 'ship it', workflow: 'review-only' },
    });
    await gw.handleInteraction(interaction as never);

    expect(orch.startTask).toHaveBeenCalledTimes(1);
    const req = orch.startTask.mock.calls[0]![0];
    expect(req).toMatchObject({
      projectId: 'proj-a',
      workflowId: 'review-only',
      title: 'ship it',
      source: 'discord-command',
    });
    expect(req.externalRef).toMatchObject({ provider: 'discord', id: 'chan-1' });
    expect(reply).toHaveBeenCalled();
  });

  it('/run without workflow omits workflowId (project default applies)', async () => {
    const { interaction } = makeInteraction('run', {
      strings: { project: 'proj-a', title: 'ship it', workflow: null },
    });
    await gw.handleInteraction(interaction as never);
    const req = orch.startTask.mock.calls[0]![0];
    expect(req.workflowId).toBeUndefined();
  });

  it('/room status reports project room status (default workflow + active tasks)', async () => {
    const { interaction, reply } = makeInteraction('room', { strings: { project: 'proj-a' }, subcommand: 'status' });
    await gw.handleInteraction(interaction as never);
    const content = (reply.mock.calls[0]![0] as { content: string }).content;
    expect(content).toContain('Project Room: proj-a');
    expect(content).toContain('Default workflow: default');
  });

  it('/room sessions lists OpenClaw session handles for the project', async () => {
    const { interaction, reply } = makeInteraction('room', { strings: { project: 'proj-a' }, subcommand: 'sessions' });
    await gw.handleInteraction(interaction as never);
    expect(orch.listProjectSessions).toHaveBeenCalledWith('proj-a');
    const content = (reply.mock.calls[0]![0] as { content: string }).content;
    expect(content).toContain('planner');
    expect(content).toContain('oc-1');
  });

  it('/room canvas refreshes the dashboard and replies with the path', async () => {
    const { interaction, reply } = makeInteraction('room', { strings: { project: 'proj-a' }, subcommand: 'canvas' });
    await gw.handleInteraction(interaction as never);
    expect(orch.refreshRoomCanvas).toHaveBeenCalledWith('proj-a');
    expect((reply.mock.calls[0]![0] as { content: string }).content).toContain('/canvas/proj-a/index.html');
  });

  it('/room session <task-id> lists that task\'s session handles', async () => {
    const { interaction, reply } = makeInteraction('room', { strings: { 'task-id': 'task-1' }, subcommand: 'session' });
    await gw.handleInteraction(interaction as never);
    expect(orch.listTaskSessions).toHaveBeenCalledWith('task-1');
    expect((reply.mock.calls[0]![0] as { content: string }).content).toContain('implementer');
  });

  it('/history lists recent tasks for the project', async () => {
    const { interaction, reply } = makeInteraction('history', { strings: { project: 'proj-a' } });
    await gw.handleInteraction(interaction as never);
    expect(orch.listRecentTasks).toHaveBeenCalledWith('proj-a', 10);
    expect((reply.mock.calls[0]![0] as { content: string }).content).toMatch(/^- /m);
  });

  it('/stats counts recent tasks by status', async () => {
    orch.listRecentTasks = vi.fn(async () => [
      makeTask({ status: 'done' }),
      makeTask({ status: 'done' }),
      makeTask({ status: 'failed' }),
    ]);
    const { interaction, reply } = makeInteraction('stats', { strings: { project: 'proj-a' } });
    await gw.handleInteraction(interaction as never);
    const content = (reply.mock.calls[0]![0] as { content: string }).content;
    expect(content).toContain('done: 2');
    expect(content).toContain('failed: 1');
  });

  it('/room infers the project from the channel binding when project omitted', async () => {
    gw = new DiscordGateway(orch, makeConfig({ projectChannelBindings: [{ channelId: 'chan-1', project: projects['proj-a']! }] }));
    const { interaction, reply } = makeInteraction('room', { strings: { project: null }, subcommand: 'status' });
    await gw.handleInteraction(interaction as never);
    expect((reply.mock.calls[0]![0] as { content: string }).content).toContain('Project Room: proj-a');
  });

  it('/approve records a maintainer approval for the task (ADR-013)', async () => {
    const { interaction, reply } = makeInteraction('approve', {
      strings: { 'task-id': 'TASK-7', note: 'rm -rf build' },
    });
    await gw.handleInteraction(interaction as never);
    expect(orch.recordApproval).toHaveBeenCalledWith('TASK-7', 'user-allowed');
    expect((reply.mock.calls[0]![0] as { content: string }).content).toContain('approved');
  });

  it('/run without project resolves the project from the Discord channel binding', async () => {
    gw = new DiscordGateway(
      orch,
      makeConfig({
        projectChannelBindings: [{ channelId: 'chan-1', project: projects['proj-a']! }],
      }),
    );
    const { interaction } = makeInteraction('run', {
      strings: { project: null, title: 'ship it', workflow: null },
    });

    await gw.handleInteraction(interaction as never);

    const req = orch.startTask.mock.calls[0]![0];
    expect(req.projectId).toBe('proj-a');
  });

  it('/run explicit project takes precedence over a Discord channel binding', async () => {
    gw = new DiscordGateway(
      orch,
      makeConfig({
        projectChannelBindings: [{ channelId: 'chan-1', project: projects['proj-b']! }],
      }),
    );
    const { interaction } = makeInteraction('run', {
      strings: { project: 'proj-a', title: 'ship it', workflow: null },
    });

    await gw.handleInteraction(interaction as never);

    const req = orch.startTask.mock.calls[0]![0];
    expect(req.projectId).toBe('proj-a');
  });

  it('/run without project in an unmapped channel keeps the existing project-required rejection', async () => {
    const { interaction, reply } = makeInteraction('run', {
      strings: { project: null, title: 'ship it', workflow: null },
    });

    await gw.handleInteraction(interaction as never);

    expect(orch.startTask).not.toHaveBeenCalled();
    expect((reply.mock.calls[0]![0] as { content: string }).content).toMatch(/missing required option: project/i);
  });

  it('fails fast when two projects bind the same Discord channel', () => {
    expect(
      () =>
        new DiscordGateway(
          orch,
          makeConfig({
            projectChannelBindings: [
              { channelId: 'chan-1', project: projects['proj-a']! },
              { channelId: 'chan-1', project: projects['proj-b']! },
            ],
          }),
        ),
    ).toThrow(/duplicate Discord channel_id/i);
  });

  it('rejects unauthorized user', async () => {
    const { interaction, reply } = makeInteraction(
      'run',
      { strings: { project: 'proj-a', title: 'x' } },
      'intruder',
    );
    await gw.handleInteraction(interaction as never);
    expect(orch.startTask).not.toHaveBeenCalled();
    const arg = reply.mock.calls[0]![0] as { content: string; ephemeral?: boolean };
    expect(arg.content).toMatch(/not authorized/i);
    expect(arg.ephemeral).toBe(true);
  });

  it('rejects unknown project on /run', async () => {
    const { interaction, reply } = makeInteraction('run', {
      strings: { project: 'ghost', title: 'x' },
    });
    await gw.handleInteraction(interaction as never);
    expect(orch.startTask).not.toHaveBeenCalled();
    expect((reply.mock.calls[0]![0] as { content: string }).content).toMatch(/unknown project/i);
  });

  it('rejects workflow outside allowed_workflows', async () => {
    const { interaction, reply } = makeInteraction('run', {
      strings: { project: 'proj-a', title: 'x', workflow: 'forbidden' },
    });
    await gw.handleInteraction(interaction as never);
    expect(orch.startTask).not.toHaveBeenCalled();
    expect((reply.mock.calls[0]![0] as { content: string }).content).toMatch(/not allowed/i);
  });

  it('/pause dispatches pauseTask', async () => {
    const { interaction } = makeInteraction('pause', { strings: { 'task-id': 'task-1' } });
    await gw.handleInteraction(interaction as never);
    expect(orch.pauseTask).toHaveBeenCalledWith('task-1');
  });

  it('/resume dispatches resumeTask', async () => {
    const { interaction } = makeInteraction('resume', { strings: { 'task-id': 'task-1' } });
    await gw.handleInteraction(interaction as never);
    expect(orch.resumeTask).toHaveBeenCalledWith('task-1');
  });

  it('/cancel dispatches cancelTask', async () => {
    const { interaction } = makeInteraction('cancel', { strings: { 'task-id': 'task-1' } });
    await gw.handleInteraction(interaction as never);
    expect(orch.cancelTask).toHaveBeenCalledWith('task-1');
  });

  it('/status with task-id reports a single task', async () => {
    const { interaction, reply } = makeInteraction('status', { strings: { 'task-id': 'task-1' } });
    await gw.handleInteraction(interaction as never);
    expect(orch.getTaskStatus).toHaveBeenCalledWith('task-1');
    expect((reply.mock.calls[0]![0] as { content: string }).content).toMatch(/task-1/);
  });

  it('/status without task-id lists active tasks for a project', async () => {
    const { interaction } = makeInteraction('status', { strings: { project: 'proj-a' } });
    await gw.handleInteraction(interaction as never);
    expect(orch.listActiveTasks).toHaveBeenCalledWith('proj-a');
  });

  it('/ask dispatches askTask and returns the answer', async () => {
    const { interaction, reply } = makeInteraction('ask', {
      strings: { 'task-id': 'task-1', question: 'why?' },
    });
    await gw.handleInteraction(interaction as never);
    expect(orch.askTask).toHaveBeenCalledWith('task-1', 'why?');
    expect((reply.mock.calls.at(-1)![0] as { content: string }).content).toMatch(/the answer/);
  });

  it('/feedback records feedback', async () => {
    const { interaction } = makeInteraction('feedback', {
      strings: { 'task-id': 'task-1', message: 'use tabs' },
    });
    await gw.handleInteraction(interaction as never);
    expect(orch.recordFeedback).toHaveBeenCalledWith('task-1', 'use tabs');
  });

  it('records a dirty-baseline approval event via the injected port', async () => {
    await gw.handleApproval({ taskId: 'task-1', approvedBy: 'user-allowed', channelId: 'chan-1' });
    expect(orch.recordApproval).toHaveBeenCalledWith('task-1', 'user-allowed');
  });

  it('rejects approval from an unauthorized user', async () => {
    await expect(
      gw.handleApproval({ taskId: 'task-1', approvedBy: 'intruder', channelId: 'chan-1' }),
    ).rejects.toThrow(/not authorized/i);
    expect(orch.recordApproval).not.toHaveBeenCalled();
  });

  it('ignores non-chat-input interactions', async () => {
    const interaction = { isChatInputCommand: () => false };
    await gw.handleInteraction(interaction as never);
    expect(orch.startTask).not.toHaveBeenCalled();
  });
});
