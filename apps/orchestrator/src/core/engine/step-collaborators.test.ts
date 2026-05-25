import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StepCollaborators } from './step-collaborators.js';
import type { ResolvedStep, StepOutputView, InterpolationSource } from '../../workflow/types.js';
import type { Task } from '../types.js';
import type { ProjectMeta } from '../registries/project-registry.js';

let worktree: string;
let templateRoot: string;

beforeEach(async () => {
  worktree = await mkdtemp(path.join(tmpdir(), 'step-collaborators-'));
  templateRoot = await mkdtemp(path.join(tmpdir(), 'step-collaborators-tpl-'));
  await writeFile(
    path.join(templateRoot, 'execute.md'),
    'Implement {{previous}} for step {{step_id}}.\nWrite to .forgeroom/outputs/{{step_index}}_{{step_id}}.md.\n',
  );
});

afterEach(async () => {
  await rm(worktree, { recursive: true, force: true });
  await rm(templateRoot, { recursive: true, force: true });
});

function task(): Task {
  return {
    id: 'task-1',
    project_id: 'project-1',
    workflow_id: 'quick',
    title: 'Implement thing',
    description: 'Do the work',
    status: 'running',
    failure_reason: null,
    source: 'discord-command',
    external_ref: null,
    issue_number: null,
    branch_name: 'feat/task-1',
    worktree_path: worktree,
    pr_number: null,
    final_slices: [],
    vars: {},
    mastra_run_id: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

const project: ProjectMeta = {
  id: 'project-1',
  path: '/repo',
  default_branch: 'main',
  package_manager: 'pnpm',
  default_workflow: 'quick',
  allowed_workflows: ['quick'],
  commands: {},
  maintainers: { discord_user_ids: [], github_logins: [] },
  template_dir: null,
};

const resolved: ResolvedStep = {
  mastraStepId: 'codex_execute:plan',
  stepId: 'plan',
  intentId: 'codex_execute',
  kind: 'execute',
  agent: 'codex',
  harness: 'default',
  promptTemplate: 'execute.md',
  vars: {},
  input_refs: {},
};

describe('StepCollaborators', () => {
  it('returns bound adapter collaborators so extracted methods keep instance state', async () => {
    const taskRow = task();
    const stepOutputs: Record<string, StepOutputView> = {};
    const interpolation: InterpolationSource = {
      task: {
        title: taskRow.title,
        description: taskRow.description,
        project: taskRow.project_id,
        branch: taskRow.branch_name,
        worktree_path: taskRow.worktree_path,
        issue_number: '',
        full_diff_path: '.forgeroom/diffs/full.diff',
        final_slices: [],
      },
      vars: {},
      stepOutputs,
    };

    const collaborators = new StepCollaborators({
      task: taskRow,
      project,
      interpolation,
      stepOutputs,
      stepCounter: { value: 0 },
      promptIndex: new Map(),
      agentOverrides: {},
      templateRoot,
      deps: {
        conductor: {
          init: async () => {},
          refine: async (_taskId, _stepId, base) => `${base}\n\nrefined`,
          update: async () => {},
          integrateFeedback: async () => {},
          answer: async () => 'answer',
        },
        approvalGate: { checkCommand: () => ({ allowed: true }) },
        agentRunner: {
          run: async () => {
            throw new Error('not used');
          },
          resume: async () => {
            throw new Error('not used');
          },
        },
        checkRunner: {
          run: async () => ({ allPassed: true, results: [] }),
        },
        taskStore: {
          updateTaskFinalSlices: async () => {},
        },
        intentRegistry: { resolve: () => ({ id: 'codex_execute', kind: 'execute', agent: 'codex', harness: 'default' }) },
        modelPolicies: { resolveTarget: () => ({ providerId: 'openclaw', runtime: 'r', model: 'm' }) },
        agentRegistry: {
          resolve: () => ({ agentId: 'codex', provider: 'openclaw', runtime: 'r', model: 'm', harness: 'default' }),
        },
      },
      callbacks: {
        recordStepRow: async () => {
          throw new Error('not used');
        },
        createStepRowId: () => 'step-row-1',
        now: () => new Date('2026-05-25T00:00:00.000Z'),
        notifyStepDone: async () => {},
      },
    });

    const { renderPrompt } = collaborators.asAdapterCollaborators();
    const promptPath = await renderPrompt(resolved, {
      vars: {},
      input_refs: { previous: 'output.md' },
    });

    expect(promptPath).toBe(path.join(worktree, '.forgeroom', 'prompts', '01_plan.md'));
    const written = await readFile(promptPath, 'utf8');
    // Template contents are loaded and {{...}} placeholders interpolated, then
    // the Conductor refine pass appends its addendum.
    expect(written).toContain('Implement output.md for step plan.');
    expect(written).toContain('.forgeroom/outputs/01_plan.md');
    expect(written).toContain('refined');
  });
});

describe('StepCollaborators.renderPrompt template loading', () => {
  function makeCollaborators(): {
    renderPrompt: ReturnType<StepCollaborators['asAdapterCollaborators']>['renderPrompt'];
  } {
    const taskRow = task();
    const stepOutputs: Record<string, StepOutputView> = {};
    const interpolation: InterpolationSource = {
      task: {
        title: taskRow.title,
        description: taskRow.description,
        project: taskRow.project_id,
        branch: taskRow.branch_name,
        worktree_path: taskRow.worktree_path,
        issue_number: '',
        full_diff_path: '.forgeroom/diffs/full.diff',
        final_slices: [],
      },
      vars: {},
      stepOutputs,
    };
    const collaborators = new StepCollaborators({
      task: taskRow,
      project,
      interpolation,
      stepOutputs,
      stepCounter: { value: 0 },
      promptIndex: new Map(),
      agentOverrides: {},
      templateRoot,
      deps: {
        conductor: {
          init: async () => {},
          refine: async (_taskId, _stepId, base) => base,
          update: async () => {},
          integrateFeedback: async () => {},
          answer: async () => 'answer',
        },
        approvalGate: { checkCommand: () => ({ allowed: true }) },
        agentRunner: {
          run: async () => {
            throw new Error('not used');
          },
          resume: async () => {
            throw new Error('not used');
          },
        },
        checkRunner: { run: async () => ({ allPassed: true, results: [] }) },
        taskStore: { updateTaskFinalSlices: async () => {} },
        intentRegistry: { resolve: () => ({ id: 'codex_execute', kind: 'execute', agent: 'codex', harness: 'default' }) },
        modelPolicies: { resolveTarget: () => ({ providerId: 'unused', runtime: 'unused', model: 'unused' }) },
        agentRegistry: {
          resolve: () => ({ agentId: 'codex', provider: 'openclaw', runtime: 'r', model: 'm', harness: 'default' }),
        },
      },
      callbacks: {
        recordStepRow: async () => {
          throw new Error('not used');
        },
        createStepRowId: () => 'step-row-1',
        now: () => new Date('2026-05-25T00:00:00.000Z'),
        notifyStepDone: async () => {},
      },
    });
    return { renderPrompt: collaborators.asAdapterCollaborators().renderPrompt };
  }

  function step(promptTemplate: string, stepId = 'plan'): ResolvedStep {
    return { ...resolved, promptTemplate, stepId, mastraStepId: `codex_execute:${stepId}` };
  }

  it('interpolates input_refs, vars, step_id and step_index into the loaded template', async () => {
    const { renderPrompt } = makeCollaborators();
    const promptPath = await renderPrompt(step('execute.md'), {
      vars: {},
      input_refs: { previous: 'prior-output.md' },
    });
    const written = await readFile(promptPath, 'utf8');
    expect(written).toContain('Implement prior-output.md for step plan.');
    expect(written).toContain('.forgeroom/outputs/01_plan.md');
    expect(written).not.toContain('{{');
  });

  it('fails fast on an unknown {{placeholder}} rather than shipping a broken prompt', async () => {
    await writeFile(path.join(templateRoot, 'bad.md'), 'Uses {{nonexistent}} placeholder.');
    const { renderPrompt } = makeCollaborators();
    await expect(renderPrompt(step('bad.md'), { vars: {}, input_refs: {} })).rejects.toThrow(/nonexistent/);
  });

  it('fails when the referenced template file is missing', async () => {
    const { renderPrompt } = makeCollaborators();
    await expect(renderPrompt(step('missing.md'), { vars: {}, input_refs: {} })).rejects.toThrow(
      /prompt template not found/,
    );
  });

  it('attaches the agent-derived runtimeTarget and writes a routing decision (ADR-024)', async () => {
    const taskRow = task();
    const stepOutputs: Record<string, StepOutputView> = {};
    const interpolation: InterpolationSource = {
      task: {
        title: taskRow.title,
        description: taskRow.description,
        project: taskRow.project_id,
        branch: taskRow.branch_name,
        worktree_path: taskRow.worktree_path,
        issue_number: '',
        full_diff_path: '.forgeroom/diffs/full.diff',
        final_slices: [],
      },
      vars: {},
      stepOutputs,
    };
    let capturedTarget: unknown;
    const collaborators = new StepCollaborators({
      task: taskRow,
      project,
      interpolation,
      stepOutputs,
      stepCounter: { value: 0 },
      promptIndex: new Map(),
      agentOverrides: {},
      templateRoot,
      deps: {
        conductor: {
          init: async () => {},
          refine: async (_t, _s, base) => base,
          update: async () => {},
          integrateFeedback: async () => {},
          answer: async () => 'answer',
        },
        approvalGate: { checkCommand: () => ({ allowed: true }) },
        agentRunner: {
          run: async (req) => {
            capturedTarget = req.runtimeTarget;
            await writeFile(req.outputPath, 'x'.repeat(60));
            return {
              exitCode: 0,
              outputExists: true,
              outputBytes: 60,
              durationMs: 1,
              sessionId: null,
              stdoutPath: req.stdoutPath,
              stderrPath: req.stderrPath,
            };
          },
          resume: async () => {
            throw new Error('not used');
          },
        },
        checkRunner: { run: async () => ({ allPassed: true, results: [] }) },
        taskStore: { updateTaskFinalSlices: async () => {} },
        intentRegistry: { resolve: () => ({ id: 'codex_execute', kind: 'execute', agent: 'codex', harness: 'default' }) },
        modelPolicies: { resolveTarget: () => ({ providerId: 'unused', runtime: 'unused', model: 'unused' }) },
        agentRegistry: {
          resolve: () => ({ agentId: 'codex', provider: 'openclaw', runtime: 'r', model: 'm', harness: 'default' }),
        },
      },
      callbacks: {
        recordStepRow: async () => {
          throw new Error('not used');
        },
        createStepRowId: () => 'step-row-1',
        now: () => new Date('2026-05-25T00:00:00.000Z'),
        notifyStepDone: async () => {},
      },
    });

    const { renderPrompt, runAgent } = collaborators.asAdapterCollaborators();
    const promptPath = await renderPrompt(resolved, { vars: {}, input_refs: { previous: 'prior-output.md' } });
    await runAgent(resolved, promptPath, { vars: {}, input_refs: { previous: 'prior-output.md' } });

    // No model_policy on the intent → agent-derived target.
    expect(capturedTarget).toEqual({ providerId: 'openclaw', runtime: 'r', model: 'm' });

    const routing = JSON.parse(
      await readFile(path.join(worktree, '.forgeroom', 'routing', '01_plan.json'), 'utf8'),
    ) as { stepId: string; policyId: string | null; selected: { runtime: string; model: string }; fallbackChain: string[] };
    expect(routing.stepId).toBe('plan');
    expect(routing.policyId).toBeNull();
    expect(routing.selected).toMatchObject({ runtime: 'r', model: 'm' });
    expect(routing.fallbackChain).toEqual([]);
  });
});
