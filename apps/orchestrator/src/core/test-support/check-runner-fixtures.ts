import { ApprovalGate } from '../checks/approval-gate.js';
import type { AgentRunner, AgentRunnerResumeRequest, AgentRunResult } from '../agent-runtime/agent-runner.js';
import { DefaultCheckRunner } from '../checks/check-runner.js';
import type { CheckRunnerArtifactStore, CheckRunnerCommandRunner } from '../checks/check-runner.js';
import type { ProjectMeta } from '../registries/project-registry.js';
import type { CreateCheckInput, TaskStore } from '../task-store.js';
import type { Check, Step, Task, TaskStatus } from '../types.js';

export class FakeCommandRunner implements CheckRunnerCommandRunner {
  requests: Array<Parameters<CheckRunnerCommandRunner['run']>[0]> = [];
  results: Array<{ exitCode: number; durationMs: number; timedOut?: boolean }> = [];

  run(input: Parameters<CheckRunnerCommandRunner['run']>[0]) {
    this.requests.push(input);
    const result = this.results.shift();
    if (!result) {
      throw new Error('missing fake command result');
    }

    return Promise.resolve({
      command: input.command,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      stdoutPath: input.stdoutPath,
      stderrPath: input.stderrPath,
      timedOut: result.timedOut ?? false,
    });
  }
}

export class FakeAgentRunner implements AgentRunner {
  resumeRequests: AgentRunnerResumeRequest[] = [];
  results: AgentRunResult[] = [];

  run(): Promise<AgentRunResult> {
    throw new Error('CheckRunner must not start a new output-producing agent run');
  }

  resume(input: AgentRunnerResumeRequest): Promise<AgentRunResult> {
    this.resumeRequests.push(input);
    const result = this.results.shift();
    if (!result) {
      throw new Error('missing fake agent resume result');
    }

    return Promise.resolve(result);
  }
}

export class FakeArtifactStore implements CheckRunnerArtifactStore {
  files = new Map<string, string>();
  writes: Array<{ path: string; content: string }> = [];

  readFile(path: string): Promise<string> {
    return Promise.resolve(this.files.get(path) ?? '');
  }

  writeFile(path: string, content: string): Promise<void> {
    this.writes.push({ path, content });
    this.files.set(path, content);
    return Promise.resolve();
  }
}

export class FakeTaskStore implements Pick<TaskStore, 'recordCheck' | 'updateStep' | 'updateTaskStatus'> {
  checks: Check[] = [];
  stepPatches: Array<{ id: string; patch: Partial<Step> }> = [];
  taskStatusPatches: Array<{
    id: string;
    status: TaskStatus;
    failureReason: Task['failure_reason'] | null | undefined;
  }> = [];

  recordCheck(input: CreateCheckInput): Promise<Check> {
    const check = { ...input, created_at: input.created_at ?? new Date() };
    this.checks.push(check);
    return Promise.resolve(check);
  }

  updateStep(id: string, patch: Partial<Step>): Promise<void> {
    this.stepPatches.push({ id, patch });
    return Promise.resolve();
  }

  updateTaskStatus(
    id: string,
    status: TaskStatus,
    failureReason?: Task['failure_reason'] | null,
  ): Promise<void> {
    this.taskStatusPatches.push({ id, status, failureReason });
    return Promise.resolve();
  }
}

export function checkIds(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `check-${String(next)}`;
  };
}

export function checkRunnerHarness(options: {
  commandResults?: Array<{ exitCode: number; durationMs: number; timedOut?: boolean }>;
  agentResults?: AgentRunResult[];
  artifactStore?: FakeArtifactStore;
  defaultTimeoutMs?: number;
} = {}): {
  commandRunner: FakeCommandRunner;
  taskStore: FakeTaskStore;
  agentRunner: FakeAgentRunner;
  artifactStore: FakeArtifactStore;
  runner: DefaultCheckRunner;
} {
  const commandRunner = new FakeCommandRunner();
  commandRunner.results = options.commandResults ?? [];
  const taskStore = new FakeTaskStore();
  const agentRunner = new FakeAgentRunner();
  agentRunner.results = options.agentResults ?? [];
  const artifactStore = options.artifactStore ?? new FakeArtifactStore();
  const runner = new DefaultCheckRunner({
    commandRunner,
    agentRunner,
    taskStore,
    artifactStore,
    approvalGate: new ApprovalGate(),
    ...(options.defaultTimeoutMs === undefined ? {} : { defaultTimeoutMs: options.defaultTimeoutMs }),
    createCheckId: checkIds(),
  });

  return { commandRunner, taskStore, agentRunner, artifactStore, runner };
}

export function task(): Task {
  return {
    id: 'task-1',
    project_id: 'project-a',
    workflow_id: 'goal-feature',
    title: 'Task 1',
    description: 'Task 1 description',
    status: 'running',
    failure_reason: null,
    source: 'discord-command',
    external_ref: null,
    issue_number: null,
    branch_name: 'forgeroom/task-1',
    worktree_path: '/tmp/forgeroom/worktrees/task-1',
    pr_number: null,
    final_slices: [],
    vars: {},
    mastra_run_id: null,
    created_at: new Date('2026-05-23T00:00:00.000Z'),
    updated_at: new Date('2026-05-23T00:00:00.000Z'),
  };
}

export function agentResult(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    exitCode: 0,
    outputExists: true,
    outputBytes: 256,
    durationMs: 100,
    sessionId: 'session-1',
    stdoutPath: '/tmp/forgeroom/worktrees/task-1/.forgeroom/logs/check_fix_execute.stdout',
    stderrPath: '/tmp/forgeroom/worktrees/task-1/.forgeroom/logs/check_fix_execute.stderr',
    ...overrides,
  };
}

export function numberedLines(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => {
    return `${prefix} ${String(index + 1).padStart(3, '0')}`;
  }).join('\n');
}

export function step(): Step {
  return {
    id: 'step-row-1',
    task_id: 'task-1',
    step_id: 'execute',
    parent_step_id: null,
    iteration: 0,
    agent_id: 'implementer',
    status: 'done',
    failure_reason: null,
    attempt: 0,
    check_fix_attempt: 0,
    check_status: 'not_run',
    prompt_path: '/tmp/forgeroom/worktrees/task-1/.forgeroom/prompts/01_execute.md',
    output_path: '/tmp/forgeroom/worktrees/task-1/.forgeroom/outputs/01_execute.md',
    diff_path: null,
    exit_code: 0,
    started_at: new Date('2026-05-23T00:00:00.000Z'),
    finished_at: new Date('2026-05-23T00:01:00.000Z'),
  };
}

export function project(
  commands: Record<string, string> = { lint: 'pnpm lint', test: 'pnpm test:unit' },
): ProjectMeta {
  return {
    id: 'project-a',
    path: '/repo/project-a',
    default_branch: 'main',
    package_manager: 'pnpm',
    default_workflow: 'goal-feature',
    allowed_workflows: ['goal-feature'],
    template_dir: null,
    commands,
    maintainers: { discord_user_ids: [], github_logins: [] },
  };
}
