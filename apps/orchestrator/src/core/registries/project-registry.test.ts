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
