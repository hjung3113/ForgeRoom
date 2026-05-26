import { describe, expect, it } from 'vitest';

import { ProjectRegistry, ProjectValidationError } from './project-registry.js';
import { WorkflowRegistry } from './workflow-registry.js';
import { AgentRegistry } from '../agent-runtime/agent-registry.js';
import { HarnessRegistry } from '../agent-runtime/harness-registry.js';
import { IntentRegistry } from './intent-registry.js';

describe('ProjectRegistry', () => {
  const workflowRegistry = makeWorkflowRegistry();

  it('loads projects with workflow, command, and maintainer metadata', () => {
    const registry = ProjectRegistry.fromConfig(
      {
        forgeroom: {
          path: '/Users/hyojung/projects/forgeroom',
          default_branch: 'main',
            package_manager: 'pnpm',
            default_workflow: 'quick',
            allowed_workflows: ['quick'],
            commands: {
              lint: 'pnpm lint',
              typecheck: 'pnpm typecheck',
              test: 'pnpm test:unit',
            },
            maintainers: { discord_user_ids: ['123'], github_logins: ['hyojung'] },
          },
      },
      workflowRegistry,
    );

    expect(registry.get('forgeroom')).toMatchObject({
      id: 'forgeroom',
      default_workflow: 'quick',
      allowed_workflows: ['quick'],
      template_dir: null,
    });
  });

  it('disables projects with missing paths and exposes diagnostics', () => {
    const registry = ProjectRegistry.fromConfig(
      {
        forgeroom: {
          path: '/Users/hyojung/projects/forgeroom',
          default_branch: 'main',
          package_manager: 'pnpm',
          default_workflow: 'quick',
          allowed_workflows: ['quick'],
          commands: {
            lint: 'pnpm lint',
            typecheck: 'pnpm typecheck',
            test: 'pnpm test:unit',
          },
          maintainers: { discord_user_ids: [], github_logins: [] },
        },
        archived: {
          path: '/Users/hyojung/projects/archived',
          default_branch: 'main',
          package_manager: 'pnpm',
          default_workflow: 'quick',
          allowed_workflows: ['quick'],
          commands: {
            lint: 'pnpm lint',
            typecheck: 'pnpm typecheck',
            test: 'pnpm test:unit',
          },
          maintainers: { discord_user_ids: [], github_logins: [] },
        },
      },
      workflowRegistry,
      { projectPathExists: (projectPath) => projectPath !== '/Users/hyojung/projects/archived' },
    );

    expect(registry.get('archived')).toBeNull();
    expect(registry.list().map((project) => project.id)).toEqual(['forgeroom']);
    expect(registry.listDisabled()).toEqual([
      {
        id: 'archived',
        path: '/Users/hyojung/projects/archived',
        error: 'project archived.path does not exist: /Users/hyojung/projects/archived',
      },
    ]);
  });

  it('rejects default workflows that are not allowed', () => {
    expect(() =>
      ProjectRegistry.fromConfig(
        {
          forgeroom: {
            path: '/Users/hyojung/projects/forgeroom',
            default_branch: 'main',
            package_manager: 'pnpm',
            default_workflow: 'full',
            allowed_workflows: ['quick'],
            commands: {
              lint: 'pnpm lint',
              typecheck: 'pnpm typecheck',
              test: 'pnpm test:unit',
            },
            maintainers: { discord_user_ids: [], github_logins: [] },
          },
        },
        workflowRegistry,
      ),
    ).toThrow(/default_workflow/);
  });

  it('rejects unknown workflows, relative paths, and missing maintainers', () => {
    expect(() =>
      ProjectRegistry.fromConfig(
        {
          forgeroom: {
            path: 'relative/path',
            default_branch: 'main',
            package_manager: 'pnpm',
            default_workflow: 'quick',
            allowed_workflows: ['quick'],
            commands: {
              lint: 'pnpm lint',
              typecheck: 'pnpm typecheck',
              test: 'pnpm test:unit',
            },
            maintainers: { discord_user_ids: [], github_logins: [] },
          },
        },
        workflowRegistry,
      ),
    ).toThrow(/absolute/);

    expect(() =>
      ProjectRegistry.fromConfig(
        {
          forgeroom: {
            path: '/Users/hyojung/projects/forgeroom',
            default_branch: 'main',
            package_manager: 'pnpm',
            default_workflow: 'missing',
            allowed_workflows: ['missing'],
            commands: {
              lint: 'pnpm lint',
              typecheck: 'pnpm typecheck',
              test: 'pnpm test:unit',
            },
            maintainers: { discord_user_ids: [], github_logins: [] },
          },
        },
        workflowRegistry,
      ),
    ).toThrow(/workflow/);

    expect(() =>
      ProjectRegistry.fromConfig(
        {
          forgeroom: {
            path: '/Users/hyojung/projects/forgeroom',
            default_branch: 'main',
            package_manager: 'pnpm',
            default_workflow: 'quick',
            allowed_workflows: ['quick'],
            commands: {
              lint: 'pnpm lint',
              typecheck: 'pnpm typecheck',
              test: 'pnpm test:unit',
            },
          },
        },
        workflowRegistry,
      ),
    ).toThrow(ProjectValidationError);
  });

  it.each(['lint', 'typecheck', 'test'] as const)('rejects projects missing the %s command', (commandName) => {
    const allCommands: Record<string, string> = {
      lint: 'pnpm lint',
      typecheck: 'pnpm typecheck',
      test: 'pnpm test:unit',
    };
    const commands = Object.fromEntries(
      Object.entries(allCommands).filter(([key]) => key !== commandName),
    );

    expect(() =>
      ProjectRegistry.fromConfig(
        {
          forgeroom: {
            path: '/Users/hyojung/projects/forgeroom',
            default_branch: 'main',
            package_manager: 'pnpm',
            default_workflow: 'quick',
            allowed_workflows: ['quick'],
            commands,
            maintainers: { discord_user_ids: [], github_logins: [] },
          },
        },
        workflowRegistry,
      ),
    ).toThrow(new RegExp(`commands.${commandName}`));
  });

  describe('ProjectRoom view (getRoom)', () => {
    function baseProject(extra: Record<string, unknown> = {}) {
      return {
        path: '/Users/hyojung/projects/forgeroom',
        default_branch: 'main',
        package_manager: 'pnpm',
        default_workflow: 'quick',
        allowed_workflows: ['quick'],
        commands: { lint: 'pnpm lint', typecheck: 'pnpm typecheck', test: 'pnpm test:unit' },
        maintainers: { discord_user_ids: [], github_logins: [] },
        ...extra,
      };
    }

    it('returns null for unknown projects', () => {
      const registry = ProjectRegistry.fromConfig({ forgeroom: baseProject() }, workflowRegistry);
      expect(registry.getRoom('nope')).toBeNull();
    });

    it('returns a room view with no sections when none are configured (zero migration)', () => {
      const registry = ProjectRegistry.fromConfig({ forgeroom: baseProject() }, workflowRegistry);
      const room = registry.getRoom('forgeroom');
      expect(room?.project.id).toBe('forgeroom');
      expect(room?.discord).toBeUndefined();
      expect(room?.openclaw).toBeUndefined();
      expect(room?.mastra).toBeUndefined();
    });

    it('parses the reserved discord/openclaw/mastra sections', () => {
      const registry = ProjectRegistry.fromConfig(
        {
          forgeroom: baseProject({
            discord: { channel_id: 'C_FORGEROOM' },
            openclaw: { room: 'forgeroom', agents: { planner: 'fr-planner', implementer: 'fr-impl' } },
            mastra: { expose_operator_tools: true },
          }),
        },
        workflowRegistry,
      );
      const room = registry.getRoom('forgeroom');
      expect(room?.discord).toEqual({ channel_id: 'C_FORGEROOM' });
      expect(room?.openclaw).toEqual({ room: 'forgeroom', agents: { planner: 'fr-planner', implementer: 'fr-impl' } });
      expect(room?.mastra).toEqual({ expose_operator_tools: true });
    });

    it('ignores unknown keys inside reserved sections (reserve, not implement)', () => {
      const registry = ProjectRegistry.fromConfig(
        {
          forgeroom: baseProject({
            discord: { channel_id: 'C1', thread_mode: 'per_task', commands: { allow: ['run'] } },
            openclaw: { room: 'r', session_strategy: 'project_issue_task', permission_profiles: { review: 'read_only' } },
            mastra: { expose_operator_tools: false, studio_project: 'forgeroom' },
          }),
        },
        workflowRegistry,
      );
      const room = registry.getRoom('forgeroom');
      expect(room?.discord).toEqual({ channel_id: 'C1' });
      expect(room?.openclaw).toEqual({ room: 'r' });
      expect(room?.mastra).toEqual({ expose_operator_tools: false });
    });

    it('does not leak room sections onto ProjectMeta from get()/list()', () => {
      const registry = ProjectRegistry.fromConfig(
        { forgeroom: baseProject({ discord: { channel_id: 'C1' } }) },
        workflowRegistry,
      );
      expect(registry.get('forgeroom')).not.toHaveProperty('discord');
      expect(registry.list()[0]).not.toHaveProperty('discord');
    });

    it.each([
      ['discord.channel_id non-string', { discord: { channel_id: 123 } }, /discord\.channel_id/],
      ['openclaw.room non-string', { openclaw: { room: 5 } }, /openclaw\.room/],
      ['openclaw.agents non-record', { openclaw: { agents: ['a'] } }, /openclaw\.agents/],
      ['openclaw.agents value non-string', { openclaw: { agents: { planner: 9 } } }, /openclaw\.agents\.planner/],
      ['mastra.expose_operator_tools non-boolean', { mastra: { expose_operator_tools: 'yes' } }, /mastra\.expose_operator_tools/],
    ])('fails fast on malformed known key: %s', (_label, section, pattern) => {
      expect(() =>
        ProjectRegistry.fromConfig({ forgeroom: baseProject(section) }, workflowRegistry),
      ).toThrow(pattern);
    });
  });
});

function makeWorkflowRegistry() {
  const harnessRegistry = HarnessRegistry.fromConfig({
    implementation: { source: '.forgeroom/harnesses/implementation' },
  });
  const agentRegistry = AgentRegistry.fromConfig(
    {
      codex: {
        provider: 'openclaw',
        runtime: 'openai-codex',
        model: 'openai/gpt-5',
        harness: 'implementation',
      },
    },
    harnessRegistry,
  );
  const intentRegistry = IntentRegistry.fromConfig({
    codex_execute: {
      kind: 'execute',
      agent: 'codex',
      harness: 'implementation',
    },
  });

  return WorkflowRegistry.fromConfig(
    {
      quick: {
        description: 'Quick workflow',
        effects: {
          worktree: 'modifies',
          external: { report: 'status', pr: 'ready' },
        },
        steps: [
          {
            type: 'run',
            id: 'implement',
            intent: 'codex_execute',
            prompt_template: 'execute.md',
          },
        ],
      },
    },
    { intentRegistry, agentRegistry, harnessRegistry },
  );
}
