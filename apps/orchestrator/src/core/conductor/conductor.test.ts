import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AgentRunnerConductorAgent,
  FileConductor,
  promotePendingToApplied,
  type ConductorAgent,
  type ConductorAgentResult,
  type ConductorGit,
} from './conductor.js';
import type { AgentRunner, AgentRunnerResumeRequest, AgentRunRequest, AgentRunResult } from '../agent-runtime/agent-runner.js';
import type { StepResult, Task } from '../types.js';

const SUMMARY_REL = path.join('.forgeroom', 'context', 'summary.md');
const FEEDBACK_REL = path.join('.forgeroom', 'context', 'feedback.md');
const VIOLATION_LOG_REL = path.join('.forgeroom', 'logs', 'conductor_scope_violation.log');

function makeTask(worktree: string): Task {
  return {
    id: 'task-1',
    project_id: 'p',
    workflow_id: 'w',
    title: 't',
    description: 'd',
    status: 'running',
    failure_reason: null,
    source: 'discord-command',
    external_ref: null,
    issue_number: null,
    branch_name: 'feat/x',
    worktree_path: worktree,
    pr_number: null,
    final_slices: [],
    vars: {},
    mastra_run_id: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

function makeStepResult(overrides: Partial<StepResult> = {}): StepResult {
  return {
    stepId: '03_impl',
    promptPath: '.forgeroom/prompts/03_impl.md',
    outputPath: '.forgeroom/outputs/03_impl.md',
    diffPath: '.forgeroom/diffs/03_impl.diff',
    status: 'done',
    ...overrides,
  };
}

class FakeTaskStore {
  upserts: Array<{ taskId: string; summary: string; summaryPath: string; lastStepId: string | null }> = [];
  constructor(private readonly task: Task) {}
  getTask(_id: string): Promise<Task | null> {
    return Promise.resolve(this.task);
  }
  upsertConductorState(
    taskId: string,
    summary: string,
    summaryPath: string,
    lastStepId?: string | null,
  ): Promise<void> {
    this.upserts.push({ taskId, summary, summaryPath, lastStepId: lastStepId ?? null });
    return Promise.resolve();
  }
}

class StaticGit implements ConductorGit {
  status(_cwd: string): Promise<string[]> {
    return Promise.resolve([]);
  }
  revert(_cwd: string, _paths: string[]): Promise<void> {
    return Promise.resolve();
  }
}

class ScriptedAgent implements ConductorAgent {
  calls: Array<{ callKind: string; prompt: string }> = [];
  constructor(private readonly results: ConductorAgentResult[]) {}
  run(input: { callKind: string; prompt: string }): Promise<ConductorAgentResult> {
    this.calls.push({ callKind: input.callKind, prompt: input.prompt });
    const next = this.results.shift();
    if (!next) {
      throw new Error('no scripted result');
    }
    return Promise.resolve(next);
  }
}

let worktree: string;

beforeEach(async () => {
  worktree = await mkdtemp(path.join(tmpdir(), 'conductor-'));
  await mkdir(path.join(worktree, '.forgeroom', 'context'), { recursive: true });
});

afterEach(async () => {
  await rm(worktree, { recursive: true, force: true });
});

describe('FileConductor.init', () => {
  it('creates empty summary and feedback files', async () => {
    const store = new FakeTaskStore(makeTask(worktree));
    const conductor = new FileConductor({
      agent: new ScriptedAgent([]),
      git: new StaticGit(),
      taskStore: store,
    });

    await conductor.init('task-1');

    await expect(access(path.join(worktree, SUMMARY_REL))).resolves.toBeUndefined();
    await expect(access(path.join(worktree, FEEDBACK_REL))).resolves.toBeUndefined();
    expect(store.upserts).toHaveLength(1);
  });
});

describe('FileConductor.update', () => {
  it('writes summary.md to disk synchronously before returning', async () => {
    const store = new FakeTaskStore(makeTask(worktree));
    const conductor = new FileConductor({
      agent: new ScriptedAgent([{ text: '# Task Summary\n\nupdated', failed: false }]),
      git: new StaticGit(),
      taskStore: store,
    });

    // No await-after-return tricks: the file must exist immediately after await.
    await conductor.update('task-1', makeStepResult());

    const content = await readFile(path.join(worktree, SUMMARY_REL), 'utf8');
    expect(content).toContain('updated');
    expect(store.upserts.at(-1)?.lastStepId).toBe('03_impl');
  });

  it('keeps existing summary on agent failure (graceful degradation)', async () => {
    await writeFile(path.join(worktree, SUMMARY_REL), '# Task Summary\n\noriginal');
    const store = new FakeTaskStore(makeTask(worktree));
    const conductor = new FileConductor({
      agent: new ScriptedAgent([{ text: '', failed: true }]),
      git: new StaticGit(),
      taskStore: store,
    });

    await conductor.update('task-1', makeStepResult());

    const content = await readFile(path.join(worktree, SUMMARY_REL), 'utf8');
    expect(content).toContain('original');
  });

  it('truncates summaries over the token budget', async () => {
    const store = new FakeTaskStore(makeTask(worktree));
    const budgetTokens = 100;
    const huge = 'x'.repeat(budgetTokens * 4 * 10); // far over budget
    const conductor = new FileConductor({
      agent: new ScriptedAgent([{ text: huge, failed: false }]),
      git: new StaticGit(),
      taskStore: store,
      maxSummaryTokens: budgetTokens,
    });

    await conductor.update('task-1', makeStepResult());

    const content = await readFile(path.join(worktree, SUMMARY_REL), 'utf8');
    expect(content.length).toBeLessThanOrEqual(budgetTokens * 4);
    expect(content).toContain('[truncated');
  });

  it('promotes Pending feedback to Applied only on step success', async () => {
    await writeFile(
      path.join(worktree, FEEDBACK_REL),
      '# User Feedback\n\n## Pending for Next Step\n- prefer composition\n\n## Applied\n',
    );
    const store = new FakeTaskStore(makeTask(worktree));
    const conductor = new FileConductor({
      agent: new ScriptedAgent([{ text: '# Task Summary', failed: false }]),
      git: new StaticGit(),
      taskStore: store,
    });

    await conductor.update('task-1', makeStepResult({ status: 'done' }));

    const content = await readFile(path.join(worktree, FEEDBACK_REL), 'utf8');
    expect(content).toContain('## Applied\n- [step: 03_impl] prefer composition');
    expect(content).not.toMatch(/## Pending for Next Step\n- prefer composition/);
  });

  it('keeps Pending feedback when the consuming step failed', async () => {
    await writeFile(
      path.join(worktree, FEEDBACK_REL),
      '# User Feedback\n\n## Pending for Next Step\n- prefer composition\n\n## Applied\n',
    );
    const store = new FakeTaskStore(makeTask(worktree));
    const conductor = new FileConductor({
      agent: new ScriptedAgent([{ text: '# Task Summary', failed: false }]),
      git: new StaticGit(),
      taskStore: store,
    });

    await conductor.update('task-1', makeStepResult({ status: 'failed' }));

    const content = await readFile(path.join(worktree, FEEDBACK_REL), 'utf8');
    expect(content).toContain('## Pending for Next Step\n- prefer composition');
    expect(content).not.toContain('[step: 03_impl]');
  });
});

describe('FileConductor.refine', () => {
  it('returns the augmented prompt on success', async () => {
    const store = new FakeTaskStore(makeTask(worktree));
    const conductor = new FileConductor({
      agent: new ScriptedAgent([{ text: 'augmented prompt', failed: false }]),
      git: new StaticGit(),
      taskStore: store,
    });

    const out = await conductor.refine('task-1', '03_impl', 'base prompt');
    expect(out).toBe('augmented prompt');
  });

  it('falls back to base prompt on agent failure', async () => {
    const store = new FakeTaskStore(makeTask(worktree));
    const conductor = new FileConductor({
      agent: new ScriptedAgent([{ text: '', failed: true }]),
      git: new StaticGit(),
      taskStore: store,
    });

    const out = await conductor.refine('task-1', '03_impl', 'base prompt');
    expect(out).toBe('base prompt');
  });
});

describe('FileConductor.integrateFeedback', () => {
  it('appends agent bullets as Pending items', async () => {
    await writeFile(path.join(worktree, FEEDBACK_REL), '# User Feedback\n\n## Pending for Next Step\n\n## Applied\n');
    const store = new FakeTaskStore(makeTask(worktree));
    const conductor = new FileConductor({
      agent: new ScriptedAgent([{ text: '- use the new API\n- add a test', failed: false }]),
      git: new StaticGit(),
      taskStore: store,
    });

    await conductor.integrateFeedback('task-1');

    const content = await readFile(path.join(worktree, FEEDBACK_REL), 'utf8');
    expect(content).toContain('- use the new API');
    expect(content).toContain('- add a test');
  });
});

describe('FileConductor.answer', () => {
  it('returns the agent answer text', async () => {
    const store = new FakeTaskStore(makeTask(worktree));
    const conductor = new FileConductor({
      agent: new ScriptedAgent([{ text: 'the answer', failed: false }]),
      git: new StaticGit(),
      taskStore: store,
    });

    expect(await conductor.answer('task-1', 'what is x?')).toBe('the answer');
  });
});

describe('promotePendingToApplied', () => {
  it('is a no-op when there are no pending items', () => {
    const fb = '# User Feedback\n\n## Pending for Next Step\n\n## Applied\n- [step: 01] done\n';
    expect(promotePendingToApplied(fb, '02')).toBe(fb);
  });
});

describe('scope guard', () => {
  it('reverts out-of-scope writes, logs the violation, and keeps the text output', async () => {
    const store = new FakeTaskStore(makeTask(worktree));
    const reverted: string[][] = [];
    const git: ConductorGit = {
      // Before: clean. After: agent wrote summary.md (allowed) AND src/x.ts (violation).
      status: (() => {
        let call = 0;
        return (_cwd: string): Promise<string[]> => {
          call += 1;
          return Promise.resolve(call === 1 ? [] : [SUMMARY_REL, path.join('src', 'x.ts')]);
        };
      })(),
      revert: (_cwd: string, paths: string[]): Promise<void> => {
        reverted.push(paths);
        return Promise.resolve();
      },
    };
    const logs: string[] = [];
    const conductor = new FileConductor({
      agent: new ScriptedAgent([{ text: 'the answer text', failed: false }]),
      git,
      taskStore: store,
      log: (line) => logs.push(line),
    });

    const out = await conductor.answer('task-1', 'q');

    expect(out).toBe('the answer text'); // text preserved
    expect(reverted).toEqual([[path.join('src', 'x.ts')]]); // only the violation reverted
    expect(logs.some((l) => l.includes('src'))).toBe(true);
    const logFile = await readFile(path.join(worktree, VIOLATION_LOG_REL), 'utf8');
    expect(logFile).toContain(path.join('src', 'x.ts'));
  });

  it('does not revert files that were already dirty before the call', async () => {
    const store = new FakeTaskStore(makeTask(worktree));
    const reverted: string[][] = [];
    const preexisting = path.join('src', 'already-dirty.ts');
    const git: ConductorGit = {
      status: (() => {
        let call = 0;
        return (_cwd: string): Promise<string[]> => {
          call += 1;
          return Promise.resolve(call === 1 ? [preexisting] : [preexisting, SUMMARY_REL]);
        };
      })(),
      revert: (_cwd: string, paths: string[]): Promise<void> => {
        reverted.push(paths);
        return Promise.resolve();
      },
    };
    const conductor = new FileConductor({
      agent: new ScriptedAgent([{ text: 'ok', failed: false }]),
      git,
      taskStore: store,
    });

    await conductor.update('task-1', makeStepResult());
    expect(reverted).toHaveLength(0);
  });
});

describe('AgentRunnerConductorAgent', () => {
  class FakeAgentRunner implements AgentRunner {
    lastRun?: AgentRunRequest;
    constructor(private readonly result: AgentRunResult) {}
    async run(req: AgentRunRequest): Promise<AgentRunResult> {
      this.lastRun = req;
      // Simulate the agent writing its output file.
      if (!this.result.failureKind) {
        await writeFile(req.outputPath, 'agent output text');
      }
      return { ...this.result, stdoutPath: req.stdoutPath, stderrPath: req.stderrPath };
    }
    resume(_req: AgentRunnerResumeRequest): Promise<AgentRunResult> {
      throw new Error('not used');
    }
  }

  it('writes the prompt file, runs, and reads the output', async () => {
    const runner = new FakeAgentRunner({
      exitCode: 0,
      outputExists: true,
      outputBytes: 100,
      durationMs: 1,
      sessionId: null,
      stdoutPath: '',
      stderrPath: '',
    });
    const agent = new AgentRunnerConductorAgent({
      agentRunner: runner,
      agentId: 'conductor',
      createCallId: () => 'c1',
    });

    const result = await agent.run({ taskId: 't', callKind: 'answer', prompt: 'hello', cwd: worktree });

    expect(result).toEqual({ text: 'agent output text', failed: false });
    expect(runner.lastRun?.mode).toBe('headless');
    const prompt = await readFile(runner.lastRun!.promptPath, 'utf8');
    expect(prompt).toBe('hello');
  });

  it('reports failure when the runner fails', async () => {
    const runner = new FakeAgentRunner({
      exitCode: 1,
      failureKind: 'agent_error',
      outputExists: false,
      outputBytes: 0,
      durationMs: 1,
      sessionId: null,
      stdoutPath: '',
      stderrPath: '',
    });
    const agent = new AgentRunnerConductorAgent({ agentRunner: runner, agentId: 'conductor' });

    const result = await agent.run({ taskId: 't', callKind: 'update', prompt: 'p', cwd: worktree });
    expect(result.failed).toBe(true);
  });
});
