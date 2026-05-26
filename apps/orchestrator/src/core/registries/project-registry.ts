import path from 'node:path';

import { WorkflowRegistry } from './workflow-registry.js';

export class ProjectValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectValidationError';
  }
}

export interface ProjectMeta {
  id: string;
  path: string;
  default_branch: string;
  package_manager: string;
  default_workflow: string;
  allowed_workflows: string[];
  template_dir: string | null;
  commands: Record<string, string>;
  maintainers: ProjectMaintainers;
}

export interface ProjectMaintainers {
  discord_user_ids: string[];
  github_logins: string[];
}

/**
 * ProjectRoom (ADR-028) — reserved Phase 1.5 seam. Only the acceptance-named
 * keys are parsed; unknown keys inside a section are ignored on purpose (the
 * roadmap fields stay non-contractual until their owning phase lands). Known
 * keys are strict: a present-but-mistyped value fails fast at boot.
 */
export interface ProjectRoom {
  project: ProjectMeta;
  discord?: ProjectRoomDiscord;
  openclaw?: ProjectRoomOpenClaw;
  mastra?: ProjectRoomMastra;
}

export interface ProjectRoomDiscord {
  channel_id?: string;
}

export interface ProjectRoomOpenClaw {
  room?: string;
  agents?: Record<string, string>;
}

export interface ProjectRoomMastra {
  expose_operator_tools?: boolean;
}

export interface DisabledProject {
  id: string;
  path: string;
  error: string;
}

export interface ProjectRegistryOptions {
  projectPathExists?: (projectPath: string) => boolean;
}

interface RawProject {
  path?: unknown;
  default_branch?: unknown;
  package_manager?: unknown;
  default_workflow?: unknown;
  allowed_workflows?: unknown;
  template_dir?: unknown;
  commands?: unknown;
  maintainers?: unknown;
  discord?: unknown;
  openclaw?: unknown;
  mastra?: unknown;
}

export class ProjectRegistry {
  private constructor(
    private readonly projects: Map<string, ProjectMeta>,
    private readonly rooms: Map<string, ProjectRoom>,
    private readonly disabled: DisabledProject[],
  ) {}

  static fromConfig(
    config: Record<string, RawProject>,
    workflowRegistry: WorkflowRegistry,
    options: ProjectRegistryOptions = {},
  ): ProjectRegistry {
    const projects = new Map<string, ProjectMeta>();
    const rooms = new Map<string, ProjectRoom>();
    const disabled: DisabledProject[] = [];
    const projectPathExists = options.projectPathExists ?? (() => true);

    for (const [id, raw] of Object.entries(config)) {
      if (id.trim() === '') {
        throw new ProjectValidationError('project id must not be empty');
      }

      const project = parseProject(id, raw, workflowRegistry);
      if (!projectPathExists(project.path)) {
        disabled.push({
          id,
          path: project.path,
          error: `project ${id}.path does not exist: ${project.path}`,
        });
        continue;
      }

      projects.set(id, project);
      rooms.set(id, parseRoom(id, raw, project));
    }

    return new ProjectRegistry(projects, rooms, disabled);
  }

  get(projectId: string): ProjectMeta | null {
    return this.projects.get(projectId) ?? null;
  }

  list(): ProjectMeta[] {
    return [...this.projects.values()];
  }

  getRoom(projectId: string): ProjectRoom | null {
    return this.rooms.get(projectId) ?? null;
  }

  listDisabled(): DisabledProject[] {
    return [...this.disabled];
  }
}

function parseProject(
  id: string,
  raw: RawProject,
  workflowRegistry: WorkflowRegistry,
): ProjectMeta {
  const projectPath = requiredString(raw.path, `project ${id}.path`);
  if (!path.isAbsolute(projectPath)) {
    throw new ProjectValidationError(`project ${id}.path must be absolute`);
  }

  const defaultWorkflow = requiredString(raw.default_workflow, `project ${id}.default_workflow`);
  const allowedWorkflows = stringArray(raw.allowed_workflows, `project ${id}.allowed_workflows`);
  if (!allowedWorkflows.includes(defaultWorkflow)) {
    throw new ProjectValidationError(`project ${id}.default_workflow must be allowed`);
  }
  for (const workflowId of allowedWorkflows) {
    if (!workflowRegistry.has(workflowId)) {
      throw new ProjectValidationError(`project ${id} references unknown workflow: ${workflowId}`);
    }
  }

  const commands = stringRecord(raw.commands, `project ${id}.commands`);
  validateRequiredCommands(commands, `project ${id}.commands`);

  return {
    id,
    path: projectPath,
    default_branch: requiredString(raw.default_branch, `project ${id}.default_branch`),
    package_manager: requiredString(raw.package_manager, `project ${id}.package_manager`),
    default_workflow: defaultWorkflow,
    allowed_workflows: allowedWorkflows,
    template_dir: optionalString(raw.template_dir),
    commands,
    maintainers: maintainers(raw.maintainers, `project ${id}.maintainers`),
  };
}

function parseRoom(id: string, raw: RawProject, project: ProjectMeta): ProjectRoom {
  const room: ProjectRoom = { project };

  if (raw.discord !== undefined) {
    const section = roomSection(raw.discord, `project ${id}.discord`);
    const discord: ProjectRoomDiscord = {};
    if (section.channel_id !== undefined) {
      discord.channel_id = roomString(section.channel_id, `project ${id}.discord.channel_id`);
    }
    room.discord = discord;
  }

  if (raw.openclaw !== undefined) {
    const section = roomSection(raw.openclaw, `project ${id}.openclaw`);
    const openclaw: ProjectRoomOpenClaw = {};
    if (section.room !== undefined) {
      openclaw.room = roomString(section.room, `project ${id}.openclaw.room`);
    }
    if (section.agents !== undefined) {
      openclaw.agents = roomStringRecord(section.agents, `project ${id}.openclaw.agents`);
    }
    room.openclaw = openclaw;
  }

  if (raw.mastra !== undefined) {
    const section = roomSection(raw.mastra, `project ${id}.mastra`);
    const mastra: ProjectRoomMastra = {};
    if (section.expose_operator_tools !== undefined) {
      mastra.expose_operator_tools = roomBoolean(
        section.expose_operator_tools,
        `project ${id}.mastra.expose_operator_tools`,
      );
    }
    room.mastra = mastra;
  }

  return room;
}

function roomSection(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ProjectValidationError(`${field} must be a mapping`);
  }
  return value;
}

function roomString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ProjectValidationError(`${field} must be a non-empty string`);
  }
  return value;
}

function roomBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ProjectValidationError(`${field} must be a boolean`);
  }
  return value;
}

function roomStringRecord(value: unknown, field: string): Record<string, string> {
  if (!isRecord(value)) {
    throw new ProjectValidationError(`${field} must be a mapping`);
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new ProjectValidationError(`${field}.${key} must be a non-empty string`);
    }
    result[key] = item;
  }
  return result;
}

function validateRequiredCommands(commands: Record<string, string>, field: string): void {
  for (const commandName of ['lint', 'typecheck', 'test'] as const) {
    if (commands[commandName] === undefined) {
      throw new ProjectValidationError(`Missing required field: ${field}.${commandName}`);
    }
  }
}

function maintainers(value: unknown, field: string): ProjectMaintainers {
  if (!isRecord(value)) {
    throw new ProjectValidationError(`${field} is required`);
  }

  return {
    discord_user_ids: stringArray(value.discord_user_ids, `${field}.discord_user_ids`),
    github_logins: stringArray(value.github_logins, `${field}.github_logins`),
  };
}

function stringRecord(value: unknown, field: string): Record<string, string> {
  if (!isRecord(value)) {
    throw new ProjectValidationError(`${field} is required`);
  }

  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new ProjectValidationError(`${field}.${key} must be a non-empty string`);
    }
    result[key] = item;
  }

  return result;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new ProjectValidationError(`${field} must be a string array`);
  }

  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new ProjectValidationError(`${field} must be a string array`);
    }
    result.push(item);
  }

  return result;
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new ProjectValidationError('template_dir must be a string or null');
  }

  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ProjectValidationError(`Missing required field: ${field}`);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
