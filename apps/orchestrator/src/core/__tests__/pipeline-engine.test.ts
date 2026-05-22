import { describe, expect, it } from 'vitest';

import type { AgentRunRequest, AgentRunResult, AgentRunner, AgentRunnerResumeRequest } from '../agent-runner';
import { DefaultPipelineEngine, type PipelineArtifactStore } from '../pipeline-engine';
import type { ProjectMeta } from '../project-registry';
import type { CreateStepInput, CreateTaskInput, TaskStore } from '../task-store';
import type { Step, Task } from '../types';
import type { ParsedWorkflow } from '../workflow-registry';
import type { WorktreeHandle } from '../worktree-manager';

describe('DefaultPipelineEngine', () => {
  it('starts a task, prepares the worktree, writes the first prompt, and runs the first step', async () => {
    const harness = makeHarness();

    const taskId = await harness.engine.runFull('forge', {
      title: 'Add orchestration',
      description: 'Implement the first slice.',
      source: 'discord-command',
    });

    expect(taskId).toBe('task-1');
    expect(harness.taskStore.createdTasks).toMatchObject([
      {
        id: 'task-1',
        project_id: 'forge',
        workflow_id: 'feature',
        title: 'Add orchestration',
        branch_name: 'forgeroom/task-1-add-orchestration',
        worktree_path: '/tmp/forgeroom/worktrees/task-1',
        status: 'queued',
      },
    ]);
    expect(harness.taskStore.lockRequests).toEqual([{ projectId: 'forge', taskId: 'task-1' }]);
    expect(harness.worktreeManager.createdTasks.map((task) => task.id)).toEqual(['task-1']);
    expect(harness.artifactStore.files.get('/tmp/forgeroom/worktrees/task-1/.forgeroom/prompts/01_plan.md')).toContain(
      'Implement the first slice.',
    );
    expect(harness.agentRunner.runs).toMatchObject([
      {
        agentId: 'codex',
        promptPath: '/tmp/forgeroom/worktrees/task-1/.forgeroom/prompts/01_plan.md',
        outputPath: '/tmp/forgeroom/worktrees/task-1/.forgeroom/outputs/01_plan.md',
        cwd: '/tmp/forgeroom/worktrees/task-1',
        mode: 'headless',
      },
    ]);
    expect(harness.taskStore.createdSteps).toMatchObject([
      {
        task_id: 'task-1',
        step_id: 'plan',
        agent_id: 'codex',
        status: 'running',
        prompt_path: '/tmp/forgeroom/worktrees/task-1/.forgeroom/prompts/01_plan.md',
        output_path: '/tmp/forgeroom/worktrees/task-1/.forgeroom/outputs/01_plan.md',
      },
    ]);
    expect(harness.taskStore.stepPatches).toEqual([
      {
        id: 'step-1',
        patch: {
          status: 'done',
          exit_code: 0,
          finished_at: harness.now,
        },
      },
    ]);
  });
});

function makeHarness() {
  const now = new Date('2026-05-23T00:00:00.000Z');
  const project: ProjectMeta = {
    id: 'forge',
    path: '/repo/forge',
    default_branch: 'main',
    package_manager: 'pnpm',
    default_workflow: 'feature',
    allowed_workflows: ['feature'],
    template_dir: null,
    commands: {
      lint: 'pnpm lint',
      typecheck: 'pnpm typecheck',
      test: 'pnpm test:unit',
    },
    maintainers: {
      discord_user_ids: [],
      github_logins: [],
    },
  };
  const workflow: ParsedWorkflow = {
    id: 'feature',
    description: 'Feature workflow',
    effects: {
      worktree: 'modifies',
      external: { report: 'status', pr: 'ready' },
    },
    steps: [
      {
        type: 'run',
        id: 'plan',
        intent: 'codex_plan',
        prompt_template: 'plan.md',
        input_refs: {},
        vars: {},
        foreach: null,
        as: null,
        steps: [],
        review: null,
        refine: null,
        until: null,
        max_iterations: null,
        pause_after: false,
        kind: 'write_plan',
        agent: 'codex',
        harness: 'planning',
      },
    ],
  };
  const taskStore = new FakeTaskStore(now);
  const artifactStore = new FakeArtifactStore([['plan.md', 'Plan ${task.title}\n\n${task.description}\n']]);
  const agentRunner = new FakeAgentRunner();
  const worktreeManager = new FakeWorktreeManager();
  const engine = new DefaultPipelineEngine({
    projectRegistry: { get: (projectId: string) => (projectId === project.id ? project : null) },
    workflowRegistry: { get: (workflowId: string) => (workflowId === workflow.id ? workflow : null) },
    taskStore,
    worktreeManager,
    agentRunner,
    artifactStore,
    createId: makeIdFactory(['task-1', 'step-1']),
    now: () => now,
  });

  return { agentRunner, artifactStore, engine, now, taskStore, worktreeManager };
}

class FakeTaskStore
  implements Pick<TaskStore, 'createTask' | 'acquireProjectLock' | 'createStep' | 'updateStep'>
{
  readonly createdTasks: CreateTaskInput[] = [];
  readonly createdSteps: CreateStepInput[] = [];
  readonly lockRequests: Array<{ projectId: string; taskId: string }> = [];
  readonly stepPatches: Array<{ id: string; patch: Partial<Step> }> = [];

  constructor(private readonly now: Date) {}

  createTask(input: CreateTaskInput): Promise<Task> {
    this.createdTasks.push(input);

    return Promise.resolve({
      ...input,
      failure_reason: input.failure_reason ?? null,
      created_at: this.now,
      updated_at: this.now,
    });
  }

  acquireProjectLock(projectId: string, taskId: string): Promise<boolean> {
    this.lockRequests.push({ projectId, taskId });
    return Promise.resolve(true);
  }

  createStep(input: CreateStepInput): Promise<Step> {
    this.createdSteps.push(input);
    return Promise.resolve(input);
  }

  updateStep(id: string, patch: Partial<Step>): Promise<void> {
    this.stepPatches.push({ id, patch });
    return Promise.resolve();
  }
}

class FakeArtifactStore implements PipelineArtifactStore {
  readonly files = new Map<string, string>();

  constructor(private readonly templates: Array<[string, string]>) {}

  readPromptTemplate(relativePath: string): Promise<string> {
    const template = new Map(this.templates).get(relativePath);
    if (template === undefined) throw new Error(`Missing template: ${relativePath}`);
    return Promise.resolve(template);
  }

  writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
    return Promise.resolve();
  }
}

class FakeAgentRunner implements AgentRunner {
  readonly runs: AgentRunRequest[] = [];

  run(req: AgentRunRequest): Promise<AgentRunResult> {
    this.runs.push(req);

    return Promise.resolve({
      exitCode: 0,
      outputExists: true,
      outputBytes: 120,
      durationMs: 1000,
      sessionId: 'session-1',
      stdoutPath: req.stdoutPath,
      stderrPath: req.stderrPath,
    });
  }

  resume(_req: AgentRunnerResumeRequest): Promise<AgentRunResult> {
    throw new Error('Unexpected resume');
  }
}

class FakeWorktreeManager {
  readonly createdTasks: Task[] = [];

  create(task: Task): Promise<WorktreeHandle> {
    this.createdTasks.push(task);
    return Promise.resolve({ path: task.worktree_path, branch: task.branch_name });
  }
}

function makeIdFactory(ids: string[]): () => string {
  return () => {
    const id = ids.shift();
    if (id === undefined) throw new Error('No ids left');
    return id;
  };
}
