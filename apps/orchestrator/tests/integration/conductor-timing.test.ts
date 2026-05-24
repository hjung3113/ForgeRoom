import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FileConductor,
  type ConductorAgent,
  type ConductorAgentResult,
} from '../../src/core/conductor.js';
import { GitCliConductorGit } from '../../src/app/conductor-git.js';
import type { StepResult, Task } from '../../src/core/types.js';

const execFileAsync = promisify(execFile);

const SUMMARY_REL = path.join('.forgeroom', 'context', 'summary.md');

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'conductor-int-'));
  await execFileAsync('git', ['init', '-q'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.name', 'test'], { cwd: repo });
  await mkdir(path.join(repo, '.forgeroom', 'context'), { recursive: true });
  await writeFile(path.join(repo, SUMMARY_REL), '# Task Summary\n');
  await writeFile(path.join(repo, '.forgeroom', 'context', 'feedback.md'), '# User Feedback\n\n## Pending for Next Step\n\n## Applied\n');
  await writeFile(path.join(repo, 'README.md'), 'tracked file\n');
  await execFileAsync('git', ['add', '-A'], { cwd: repo });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

function makeTask(): Task {
  return {
    id: 'task-int',
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
    worktree_path: repo,
    pr_number: null,
    final_slices: [],
    vars: {},
    mastra_run_id: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

const stepResult: StepResult = {
  stepId: '03_impl',
  promptPath: '.forgeroom/prompts/03_impl.md',
  outputPath: '.forgeroom/outputs/03_impl.md',
  diffPath: null,
  status: 'done',
};

const noopTaskStore = {
  getTask: (): Promise<Task | null> => Promise.resolve(makeTask()),
  upsertConductorState: (): Promise<void> => Promise.resolve(),
};

describe('Conductor ADR-016 timing (integration)', () => {
  it('summary.md is on disk before a simulated suspend gate runs', async () => {
    // Agent that writes only the allowed summary.md (well-behaved).
    const agent: ConductorAgent = {
      async run(): Promise<ConductorAgentResult> {
        return { text: '# Task Summary\n\nstep 03 complete', failed: false };
      },
    };
    const conductor = new FileConductor({ agent, git: new GitCliConductorGit(), taskStore: noopTaskStore });

    // Simulated execute-step body order from ADR-016:
    //   agent run -> CheckRunner -> diff save -> Conductor.update -> Reporter -> suspend gate.
    let summaryOnDiskAtSuspend = false;
    await conductor.update('task-int', stepResult);
    // pauseAfterGate (owned by #6) would suspend HERE; assert files are committed.
    const suspendGate = async (): Promise<void> => {
      try {
        await access(path.join(repo, SUMMARY_REL));
        summaryOnDiskAtSuspend = true;
      } catch {
        summaryOnDiskAtSuspend = false;
      }
    };
    await suspendGate();

    expect(summaryOnDiskAtSuspend).toBe(true);
    const content = await readFile(path.join(repo, SUMMARY_REL), 'utf8');
    expect(content).toContain('step 03 complete');
  });

  it('reverts a real out-of-scope write but keeps the allowed summary write', async () => {
    const offending = path.join('src', 'leak.ts');
    const agent: ConductorAgent = {
      async run(input): Promise<ConductorAgentResult> {
        // Allowed write.
        await writeFile(path.join(input.cwd, SUMMARY_REL), '# Task Summary\n\nconductor wrote this');
        // Out-of-scope write (new untracked file).
        await mkdir(path.join(input.cwd, 'src'), { recursive: true });
        await writeFile(path.join(input.cwd, offending), 'export const secret = 1;\n');
        return { text: 'augmented prompt', failed: false };
      },
    };
    const conductor = new FileConductor({ agent, git: new GitCliConductorGit(), taskStore: noopTaskStore });

    const out = await conductor.refine('task-int', '03_impl', 'base');

    expect(out).toBe('augmented prompt'); // text preserved
    await expect(access(path.join(repo, offending))).rejects.toThrow(); // reverted
    const summary = await readFile(path.join(repo, SUMMARY_REL), 'utf8');
    // refine does not persist summary, but the agent's allowed write must NOT be reverted.
    expect(summary).toContain('conductor wrote this');
    const log = await readFile(path.join(repo, '.forgeroom', 'logs', 'conductor_scope_violation.log'), 'utf8');
    expect(log).toContain('leak.ts');
  });

  it('reverts an out-of-scope modification to a tracked file', async () => {
    const agent: ConductorAgent = {
      async run(input): Promise<ConductorAgentResult> {
        await writeFile(path.join(input.cwd, 'README.md'), 'tampered by conductor\n');
        return { text: 'answer', failed: false };
      },
    };
    const conductor = new FileConductor({ agent, git: new GitCliConductorGit(), taskStore: noopTaskStore });

    await conductor.answer('task-int', 'q');

    const readme = await readFile(path.join(repo, 'README.md'), 'utf8');
    expect(readme).toBe('tracked file\n'); // restored to HEAD
  });
});
