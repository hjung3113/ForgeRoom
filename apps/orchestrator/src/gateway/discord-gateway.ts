/**
 * DiscordGateway — MVP Discord slash-command TaskSource (issue #27, ADR-013).
 *
 * Thin adapter only: parses + authorizes + dispatches each slash command to an
 * INJECTED orchestrator facade ({@link OrchestratorGatewayPort}). It never
 * touches the TaskStore directly, never runs PipelineEngine internals, and
 * never holds business logic — for /run it builds a {@link TaskRequest}, for
 * the control commands it calls an intent-level port method. The composition
 * root implements the port by delegating to PipelineEngine / Conductor /
 * TaskStore.
 *
 * discord.js stays inside this adapter (gateway/ rule 2: core must not import
 * discord.js). The handlers accept the discord.js interaction object but route
 * everything through the port so they are unit-testable with a fake interaction
 * and a fake port (no live Discord).
 */
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Interaction,
  type SlashCommandOptionsOnlyBuilder,
} from 'discord.js';

import type { Task, TaskRequest } from '../core/types.js';

// ---------------------------------------------------------------------------
// Injected orchestrator facade (gateway-owned port).
// ---------------------------------------------------------------------------

/**
 * Intent-level seam the gateway dispatches to. The composition root implements
 * it on top of PipelineEngine.runFull/pause/resume/cancel,
 * Conductor.answer/integrateFeedback, and the TaskStore. Keeping the surface
 * narrow (only what the seven commands need) keeps the adapter thin and makes
 * unit tests trivial fakes.
 */
export interface OrchestratorGatewayPort {
  /** /run — start a task; returns the new task id. */
  startTask(request: TaskRequest): Promise<string>;
  /** /pause */
  pauseTask(taskId: string): Promise<void>;
  /** /resume */
  resumeTask(taskId: string): Promise<void>;
  /** /cancel */
  cancelTask(taskId: string): Promise<void>;
  /** /status <task-id> */
  getTaskStatus(taskId: string): Promise<Task | null>;
  /** /status [project] */
  listActiveTasks(projectId?: string): Promise<Task[]>;
  /** /history, /stats — recent tasks for a project (newest first, all statuses). */
  listRecentTasks(projectId: string, limit: number): Promise<Task[]>;
  /** /ask — Conductor.answer on the task context. */
  askTask(taskId: string, question: string): Promise<string>;
  /** /feedback — recorded for the next step's Conductor.refine input. */
  recordFeedback(taskId: string, message: string): Promise<void>;
  /** Dirty-baseline approval — records the approval event (ADR-013). */
  recordApproval(taskId: string, approvedBy: string): Promise<void>;
}

/** Minimal project view the gateway needs for authorization + workflow checks. */
export interface ProjectLookup {
  id: string;
  default_workflow: string;
  allowed_workflows: string[];
}

export interface DiscordProjectChannelBinding {
  channelId: string;
  project: ProjectLookup;
}

export interface DiscordGatewayConfig {
  token: string;
  applicationId: string;
  /** Guilds the slash commands are registered to. */
  guildIds: string[];
  /** Discord user-id allowlist (Docs/modules/discord-gateway.md). */
  allowedUserIds: string[];
  /** Project resolver (composition root wraps ProjectRegistry). */
  lookupProject(projectId: string): ProjectLookup | null;
  /** ADR-028 Project Room channel bindings, derived from ProjectRegistry.getRoom(). */
  projectChannelBindings?: DiscordProjectChannelBinding[];
}

export interface ApprovalRequest {
  taskId: string;
  approvedBy: string;
  channelId: string;
}

const TASK_SOURCE: Task['source'] = 'discord-command';

// A rejection the handlers surface to the user as an ephemeral reply rather
// than crashing the interaction.
class CommandRejection extends Error {}

// ---------------------------------------------------------------------------

export class DiscordGateway {
  private readonly client: Client;
  private readonly projectByChannelId: Map<string, ProjectLookup>;

  constructor(
    private readonly orchestrator: OrchestratorGatewayPort,
    private readonly config: DiscordGatewayConfig,
  ) {
    this.projectByChannelId = buildProjectByChannelId(config.projectChannelBindings ?? []);
    this.client = new Client({ intents: [GatewayIntentBits.Guilds] });
    this.client.on('interactionCreate', (interaction: Interaction) => {
      void this.handleInteraction(interaction);
    });
  }

  /** Connect and register slash commands. */
  async start(): Promise<void> {
    await this.registerSlashCommands();
    await this.client.login(this.config.token);
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  /** Build the seven MVP slash commands (no step-level override options). */
  buildSlashCommands(): SlashCommandOptionsOnlyBuilder[] {
    const run = new SlashCommandBuilder()
      .setName('run')
      .setDescription('Start a task for a project')
      .addStringOption((o) => o.setName('project').setDescription('Project id'))
      .addStringOption((o) => o.setName('title').setDescription('Task title').setRequired(true))
      .addStringOption((o) =>
        o.setName('workflow').setDescription('Workflow id (within allowed_workflows)'),
      );

    const withTaskId = (name: string, description: string) =>
      new SlashCommandBuilder()
        .setName(name)
        .setDescription(description)
        .addStringOption((o) => o.setName('task-id').setDescription('Task id').setRequired(true));

    const pause = withTaskId('pause', 'Pause a running task');
    const resume = withTaskId('resume', 'Resume a paused task');
    const cancel = withTaskId('cancel', 'Cancel a task');

    const status = new SlashCommandBuilder()
      .setName('status')
      .setDescription('Report task status')
      .addStringOption((o) => o.setName('task-id').setDescription('Task id'))
      .addStringOption((o) => o.setName('project').setDescription('Project id'));

    const ask = new SlashCommandBuilder()
      .setName('ask')
      .setDescription('Ask about the current task context')
      .addStringOption((o) => o.setName('task-id').setDescription('Task id').setRequired(true))
      .addStringOption((o) => o.setName('question').setDescription('Question').setRequired(true));

    const feedback = new SlashCommandBuilder()
      .setName('feedback')
      .setDescription('Give feedback applied from the next step')
      .addStringOption((o) => o.setName('task-id').setDescription('Task id').setRequired(true))
      .addStringOption((o) => o.setName('message').setDescription('Feedback message').setRequired(true));

    const withOptionalProject = (name: string, description: string) =>
      new SlashCommandBuilder()
        .setName(name)
        .setDescription(description)
        .addStringOption((o) => o.setName('project').setDescription('Project id (inferred from channel if omitted)'));

    const room = withOptionalProject('room', 'Show this Project Room status');
    const history = withOptionalProject('history', 'Recent tasks for this Project Room');
    const stats = withOptionalProject('stats', 'Task outcome counts for this Project Room');

    const approve = new SlashCommandBuilder()
      .setName('approve')
      .setDescription('Approve a task gated on maintainer approval (ADR-013)')
      .addStringOption((o) => o.setName('task-id').setDescription('Task id').setRequired(true))
      .addStringOption((o) => o.setName('note').setDescription('Optional note (e.g. the risky command)'));

    return [run, pause, resume, cancel, status, ask, feedback, room, history, stats, approve];
  }

  private async registerSlashCommands(): Promise<void> {
    const rest = new REST().setToken(this.config.token);
    const body = this.buildSlashCommands().map((c) => c.toJSON());
    for (const guildId of this.config.guildIds) {
      await rest.put(Routes.applicationGuildCommands(this.config.applicationId, guildId), { body });
    }
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  async handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) return;

    if (!this.isAuthorized(interaction.user.id)) {
      await this.reject(interaction, 'You are not authorized to use ForgeRoom commands.');
      return;
    }

    try {
      switch (interaction.commandName) {
        case 'run':
          return await this.handleRun(interaction);
        case 'pause':
          return await this.handleControl(interaction, (id) => this.orchestrator.pauseTask(id), 'paused');
        case 'resume':
          return await this.handleControl(interaction, (id) => this.orchestrator.resumeTask(id), 'resumed');
        case 'cancel':
          return await this.handleControl(interaction, (id) => this.orchestrator.cancelTask(id), 'canceled');
        case 'status':
          return await this.handleStatus(interaction);
        case 'ask':
          return await this.handleAsk(interaction);
        case 'feedback':
          return await this.handleFeedback(interaction);
        case 'room':
          return await this.handleRoom(interaction);
        case 'history':
          return await this.handleHistory(interaction);
        case 'stats':
          return await this.handleStats(interaction);
        case 'approve':
          return await this.handleApproveCommand(interaction);
        default:
          await this.reject(interaction, `Unknown command: /${interaction.commandName}`);
      }
    } catch (error) {
      const content =
        error instanceof CommandRejection
          ? error.message
          : `Command failed: ${error instanceof Error ? error.message : String(error)}`;
      await this.reply(interaction, content, true);
    }
  }

  /**
   * Dirty-baseline approval (ADR-013): only the originating requester or a
   * project maintainer in the allowlist may approve. The approval event is
   * recorded via the injected port.
   */
  async handleApproval(request: ApprovalRequest): Promise<void> {
    if (!this.isAuthorized(request.approvedBy)) {
      throw new CommandRejection(`User ${request.approvedBy} is not authorized to approve.`);
    }
    await this.orchestrator.recordApproval(request.taskId, request.approvedBy);
  }

  // -------------------------------------------------------------------------
  // Command handlers
  // -------------------------------------------------------------------------

  private async handleRun(interaction: ChatInputCommandInteraction): Promise<void> {
    const projectId = this.resolveRunProjectId(interaction);
    const title = this.requireString(interaction, 'title');
    const workflowId = interaction.options.getString('workflow') ?? undefined;

    const project = this.config.lookupProject(projectId);
    if (!project) {
      throw new CommandRejection(`Unknown project: ${projectId}`);
    }
    if (workflowId && !project.allowed_workflows.includes(workflowId)) {
      throw new CommandRejection(
        `Workflow "${workflowId}" is not allowed for project ${projectId}.`,
      );
    }

    const request: TaskRequest = {
      projectId,
      ...(workflowId ? { workflowId } : {}),
      title,
      description: '',
      source: TASK_SOURCE,
      externalRef: {
        provider: 'discord',
        id: interaction.channelId,
      },
    };

    const taskId = await this.orchestrator.startTask(request);
    await this.reply(interaction, `Task ${taskId} queued.`);
  }

  private resolveRunProjectId(interaction: ChatInputCommandInteraction): string {
    const explicitProjectId = interaction.options.getString('project');
    if (explicitProjectId !== null && explicitProjectId !== '') {
      return explicitProjectId;
    }
    const channelProject = this.projectByChannelId.get(interaction.channelId);
    if (channelProject !== undefined) {
      return channelProject.id;
    }
    throw new CommandRejection(`Missing required option: project`);
  }

  private async handleControl(
    interaction: ChatInputCommandInteraction,
    action: (taskId: string) => Promise<void>,
    pastTense: string,
  ): Promise<void> {
    const taskId = this.requireString(interaction, 'task-id');
    await action(taskId);
    await this.reply(interaction, `Task ${taskId} ${pastTense}.`);
  }

  private async handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
    const taskId = interaction.options.getString('task-id');
    if (taskId) {
      const task = await this.orchestrator.getTaskStatus(taskId);
      await this.reply(
        interaction,
        task ? `Task ${task.id}: ${task.status}` : `Task ${taskId} not found.`,
      );
      return;
    }
    const projectId = interaction.options.getString('project') ?? undefined;
    const tasks = await this.orchestrator.listActiveTasks(projectId);
    const lines = tasks.map((t) => `- ${t.id} (${t.project_id}): ${t.status}`);
    await this.reply(
      interaction,
      lines.length > 0 ? lines.join('\n') : 'No active tasks.',
    );
  }

  private async handleRoom(interaction: ChatInputCommandInteraction): Promise<void> {
    const projectId = this.resolveRunProjectId(interaction);
    const project = this.config.lookupProject(projectId);
    if (project === null) {
      await this.reply(interaction, `Unknown project: ${projectId}`);
      return;
    }
    const active = await this.orchestrator.listActiveTasks(projectId);
    const lines = [
      `Project Room: ${projectId}`,
      `Default workflow: ${project.default_workflow}`,
      `Allowed workflows: ${project.allowed_workflows.join(', ')}`,
      `Active tasks: ${active.length}`,
      ...active.map((t) => `  - ${t.id} (${t.status})`),
    ];
    await this.reply(interaction, lines.join('\n'));
  }

  private async handleHistory(interaction: ChatInputCommandInteraction): Promise<void> {
    const projectId = this.resolveRunProjectId(interaction);
    const tasks = await this.orchestrator.listRecentTasks(projectId, 10);
    const lines = tasks.map((t) => `- ${t.id} [${t.status}] ${t.title}`);
    await this.reply(interaction, lines.length > 0 ? lines.join('\n') : `No tasks for ${projectId}.`);
  }

  private async handleStats(interaction: ChatInputCommandInteraction): Promise<void> {
    const projectId = this.resolveRunProjectId(interaction);
    const tasks = await this.orchestrator.listRecentTasks(projectId, 100);
    const counts = new Map<string, number>();
    for (const t of tasks) {
      counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
    }
    const ordered = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const lines = [
      `Project Room ${projectId} — last ${tasks.length} task(s)`,
      ...ordered.map(([status, n]) => `  ${status}: ${n}`),
    ];
    await this.reply(interaction, tasks.length > 0 ? lines.join('\n') : `No tasks for ${projectId}.`);
  }

  private async handleApproveCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const taskId = this.requireString(interaction, 'task-id');
    const note = interaction.options.getString('note') ?? undefined;
    await this.handleApproval({ taskId, approvedBy: interaction.user.id, channelId: interaction.channelId });
    const suffix = note === undefined ? '' : ` (${note})`;
    await this.reply(interaction, `Task ${taskId} approved by <@${interaction.user.id}>${suffix}.`);
  }

  private async handleAsk(interaction: ChatInputCommandInteraction): Promise<void> {
    const taskId = this.requireString(interaction, 'task-id');
    const question = this.requireString(interaction, 'question');
    const answer = await this.orchestrator.askTask(taskId, question);
    await this.reply(interaction, answer);
  }

  private async handleFeedback(interaction: ChatInputCommandInteraction): Promise<void> {
    const taskId = this.requireString(interaction, 'task-id');
    const message = this.requireString(interaction, 'message');
    await this.orchestrator.recordFeedback(taskId, message);
    await this.reply(interaction, `Feedback recorded for task ${taskId} (applied from the next step).`);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private isAuthorized(userId: string): boolean {
    return this.config.allowedUserIds.includes(userId);
  }

  private requireString(interaction: ChatInputCommandInteraction, name: string): string {
    const value = interaction.options.getString(name);
    if (value === null || value === '') {
      throw new CommandRejection(`Missing required option: ${name}`);
    }
    return value;
  }

  private async reject(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
    await this.reply(interaction, content, true);
  }

  private async reply(
    interaction: ChatInputCommandInteraction,
    content: string,
    ephemeral = false,
  ): Promise<void> {
    await interaction.reply({ content, ephemeral });
  }
}

function buildProjectByChannelId(bindings: DiscordProjectChannelBinding[]): Map<string, ProjectLookup> {
  const result = new Map<string, ProjectLookup>();
  for (const binding of bindings) {
    const existing = result.get(binding.channelId);
    if (existing !== undefined && existing.id !== binding.project.id) {
      throw new Error(
        `duplicate Discord channel_id ${binding.channelId} for projects ${existing.id} and ${binding.project.id}`,
      );
    }
    result.set(binding.channelId, binding.project);
  }
  return result;
}
