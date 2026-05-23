import type { AgentRunRequest, AgentRunResult, AgentRunner, AgentRunnerResumeRequest } from '../agent-runner';
import type { CheckRunnerRequest } from '../check-runner';
import type { AgentRunFailureKind } from '../agent-runner';
import { DefaultPipelineEngine } from '../pipeline-engine';
import type { PipelineArtifactStore } from '../pipeline-executor';
import type { ProjectMeta } from '../project-registry';
import type { CreateStepInput, CreateTaskInput, TaskStore } from '../task-store';
import type { Step, Task } from '../types';
import type { ParsedWorkflow, ResolvedStep } from '../workflow-registry';
import type { WorktreeHandle } from '../worktree-manager';
import { step } from './pipeline-task-fixtures';
export { task } from './pipeline-task-fixtures';

export function makePipelineHarness(
  options: {
    firstStepKind?: string;
    checksPass?: boolean;
    agentFailureKind?: AgentRunFailureKind;
    workflowSteps?: ResolvedStep[];
    templates?: Array<[string, string]>;
    agentOutputs?: string[];
  } = {},
) {
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
    steps: options.workflowSteps ?? [
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
        kind: options.firstStepKind ?? 'write_plan',
        agent: 'codex',
        harness: 'planning',
      },
    ],
  };
  const taskStore = new FakeTaskStore(now);
  const artifactStore = new FakeArtifactStore(
    options.templates ?? [['plan.md', 'Plan ${task.title}\n\n${task.description}\n']],
  );
  const agentRunner = new FakeAgentRunner(artifactStore, options.agentFailureKind, options.agentOutputs);
  const checkRunner = new FakeCheckRunner(options.checksPass ?? true);
  const worktreeManager = new FakeWorktreeManager();
  const engine = new DefaultPipelineEngine({
    projectRegistry: { get: (projectId: string) => (projectId === project.id ? project : null) },
    workflowRegistry: { get: (workflowId: string) => (workflowId === workflow.id ? workflow : null) },
    taskStore,
    worktreeManager,
    agentRunner,
    checkRunner,
    artifactStore,
    createId: makeIdFactory(['task-1', 'step-1', 'step-2', 'step-3', 'step-4', 'step-5', 'event-1']),
    now: () => now,
  });

  return { agentRunner, artifactStore, checkRunner, engine, now, taskStore, worktreeManager };
}

export class FakeTaskStore
  implements
    Pick<
      TaskStore,
      | 'createTask'
      | 'getTask'
      | 'listActiveTasks'
      | 'acquireProjectLock'
      | 'releaseProjectLock'
      | 'createStep'
      | 'updateStep'
      | 'updateTaskStatus'
      | 'updateTaskFinalSlices'
      | 'listSteps'
      | 'cancelTask'
    >
{
  readonly createdTasks: CreateTaskInput[] = [];
  readonly createdSteps: CreateStepInput[] = [];
  readonly tasks = new Map<string, Task>();
  readonly lockRequests: Array<{ projectId: string; taskId: string }> = [];
  readonly releaseLockRequests: Array<{ projectId: string; taskId: string }> = [];
  readonly stepPatches: Array<{ id: string; patch: Partial<Step> }> = [];
  readonly taskStatusUpdates: Array<{ id: string; status: Task['status']; failureReason?: Task['failure_reason'] }> =
    [];
  readonly finalSliceUpdates: Array<{ id: string; finalSlices: string[] }> = [];
  readonly cancelRequests: Array<{ taskId: string; eventId: string; payload?: Record<string, unknown> }> = [];

  constructor(private readonly now: Date) {}

  createTask(input: CreateTaskInput): Promise<Task> {
    this.createdTasks.push(input);

    const task = {
      ...input,
      failure_reason: input.failure_reason ?? null,
      created_at: this.now,
      updated_at: this.now,
    };
    this.tasks.set(task.id, task);

    return Promise.resolve(task);
  }

  getTask(id: string): Promise<Task | null> {
    return Promise.resolve(this.tasks.get(id) ?? null);
  }

  listActiveTasks(): Promise<Task[]> {
    return Promise.resolve([...this.tasks.values()].filter((task) => task.status === 'running' || task.status === 'paused'));
  }

  acquireProjectLock(projectId: string, taskId: string): Promise<boolean> {
    this.lockRequests.push({ projectId, taskId });
    return Promise.resolve(true);
  }

  releaseProjectLock(projectId: string, taskId: string): Promise<void> {
    this.releaseLockRequests.push({ projectId, taskId });
    return Promise.resolve();
  }

  createStep(input: CreateStepInput): Promise<Step> {
    this.createdSteps.push(input);
    return Promise.resolve(input);
  }

  listSteps(taskId: string): Promise<Step[]> {
    return Promise.resolve(this.createdSteps.filter((step) => step.task_id === taskId));
  }

  updateStep(id: string, patch: Partial<Step>): Promise<void> {
    this.stepPatches.push({ id, patch });
    return Promise.resolve();
  }

  updateTaskStatus(id: string, status: Task['status'], failureReason?: Task['failure_reason']): Promise<void> {
    this.taskStatusUpdates.push({
      id,
      status,
      ...(failureReason === undefined ? {} : { failureReason }),
    });
    this.setTaskStatus(id, status);
    return Promise.resolve();
  }

  updateTaskFinalSlices(id: string, finalSlices: string[]): Promise<void> {
    this.finalSliceUpdates.push({ id, finalSlices });
    const task = this.tasks.get(id);
    if (task !== undefined) {
      this.tasks.set(id, { ...task, final_slices: finalSlices });
    }
    return Promise.resolve();
  }

  cancelTask(taskId: string, eventId: string, payload?: Record<string, unknown>): Promise<void> {
    this.cancelRequests.push({
      taskId,
      eventId,
      ...(payload === undefined ? {} : { payload }),
    });
    return Promise.resolve();
  }

  setTaskStatus(id: string, status: Task['status']): void {
    const task = this.tasks.get(id);
    if (task !== undefined) {
      this.tasks.set(id, { ...task, status });
    }
  }

  seedTask(seed: Task): void {
    this.tasks.set(seed.id, seed);
  }

  seedStep(seed: Partial<Step> & Pick<Step, 'task_id' | 'step_id' | 'status'>): void {
    this.createdSteps.push(step(seed));
  }
}

export class FakeArtifactStore implements PipelineArtifactStore {
  readonly files = new Map<string, string>();

  constructor(private readonly templates: Array<[string, string]>) {}

  readPromptTemplate(relativePath: string): Promise<string> {
    const template = new Map(this.templates).get(relativePath);
    if (template === undefined) throw new Error(`Missing template: ${relativePath}`);
    return Promise.resolve(template);
  }

  readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`Missing file: ${path}`);
    return Promise.resolve(content);
  }

  writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
    return Promise.resolve();
  }
}

export class FakeAgentRunner implements AgentRunner {
  readonly runs: AgentRunRequest[] = [];

  constructor(
    private readonly artifactStore: FakeArtifactStore,
    private readonly failureKind?: AgentRunFailureKind,
    private readonly outputs: string[] = ['Agent output\n'],
  ) {}

  run(req: AgentRunRequest): Promise<AgentRunResult> {
    this.runs.push(req);
    void this.artifactStore.writeFile(req.outputPath, this.outputs.shift() ?? 'Agent output\n');

    return Promise.resolve({
      exitCode: this.failureKind === undefined ? 0 : 1,
      ...(this.failureKind === undefined ? {} : { failureKind: this.failureKind }),
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

export class FakeCheckRunner {
  readonly requests: CheckRunnerRequest[] = [];

  constructor(private readonly checksPass: boolean) {}

  run(request: CheckRunnerRequest): Promise<{ allPassed: boolean; results: [] }> {
    this.requests.push(request);
    return Promise.resolve({ allPassed: this.checksPass, results: [] });
  }
}

export class FakeWorktreeManager {
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
