import type { AgentRunRequest, AgentRunResult, AgentRunner, AgentRunnerResumeRequest } from '../agent-runner';
import type { CheckRunnerRequest } from '../check-runner';
import { DefaultPipelineEngine, type PipelineArtifactStore } from '../pipeline-engine';
import type { ProjectMeta } from '../project-registry';
import type { CreateStepInput, CreateTaskInput, TaskStore } from '../task-store';
import type { Step, Task } from '../types';
import type { ParsedWorkflow } from '../workflow-registry';
import type { WorktreeHandle } from '../worktree-manager';

export function makePipelineHarness(options: { firstStepKind?: string; checksPass?: boolean } = {}) {
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
        kind: options.firstStepKind ?? 'write_plan',
        agent: 'codex',
        harness: 'planning',
      },
    ],
  };
  const taskStore = new FakeTaskStore(now);
  const artifactStore = new FakeArtifactStore([['plan.md', 'Plan ${task.title}\n\n${task.description}\n']]);
  const agentRunner = new FakeAgentRunner();
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
    createId: makeIdFactory(['task-1', 'step-1']),
    now: () => now,
  });

  return { agentRunner, artifactStore, checkRunner, engine, now, taskStore, worktreeManager };
}

export class FakeTaskStore
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

export class FakeArtifactStore implements PipelineArtifactStore {
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

export class FakeAgentRunner implements AgentRunner {
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
