import { mkdir, readFile, writeFile, appendFile, access, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import type { AgentRunner } from './agent-runner.js';
import type { Conductor, StepResult, Task } from './types.js';
import type { TaskStore } from './task-store.js';

const execFileAsync = promisify(execFile);

/**
 * Git surface the Conductor needs for its post-run scope guard. Kept narrow so
 * tests can drive a real git repo (via a CommandRunner-backed adapter) or a
 * fake. `status` returns worktree-relative changed paths (porcelain set).
 */
export interface ConductorGit {
  /** Worktree-relative paths that differ from HEAD (tracked + untracked). */
  status(cwd: string): Promise<string[]>;
  /** Revert tracked modifications and delete untracked files for the given paths. */
  revert(cwd: string, paths: string[]): Promise<void>;
}

export interface ConductorAgentResult {
  /** The agent's text response (already read from the output file). */
  text: string;
  /** True when the agent run failed even after the runner's own retries. */
  failed: boolean;
}

/**
 * Thin seam over AgentRunner that hides the file-based prompt/output protocol.
 * Production wiring writes the prompt file, runs the agent, and reads the
 * output back. Tests inject a fake to avoid a real LLM (testing-rules).
 */
export interface ConductorAgent {
  run(input: {
    taskId: string;
    callKind: 'refine' | 'update' | 'integrateFeedback' | 'answer';
    prompt: string;
    cwd: string;
  }): Promise<ConductorAgentResult>;
}

export interface ConductorDeps {
  agent: ConductorAgent;
  git: ConductorGit;
  taskStore: Pick<TaskStore, 'getTask' | 'upsertConductorState'>;
  /** Approx token budget for summary.md. Defaults to 4000 (ADR/conductor.md). */
  maxSummaryTokens?: number;
  now?: () => Date;
  /** Logger sink; defaults to stderr. Injected in tests to assert violations. */
  log?: (line: string) => void;
}

const DEFAULT_MAX_SUMMARY_TOKENS = 4000;
const CHARS_PER_TOKEN = 4;
const TRUNCATION_MARKER = '\n\n[truncated: summary exceeded token budget]\n';

// OS-native paths for fs operations.
const CONTEXT_DIR = path.join('.forgeroom', 'context');
const SCOPE_VIOLATION_LOG_REL = path.join('.forgeroom', 'logs', 'conductor_scope_violation.log');
const SUMMARY_FS_REL = path.join(CONTEXT_DIR, 'summary.md');
const FEEDBACK_FS_REL = path.join(CONTEXT_DIR, 'feedback.md');

// Forward-slash forms for comparison against git porcelain output (always '/').
const SUMMARY_REL = '.forgeroom/context/summary.md';
const FEEDBACK_REL = '.forgeroom/context/feedback.md';

const ALLOWED_WRITE_PATHS = new Set([SUMMARY_REL, FEEDBACK_REL]);

// The Conductor's own file-based prompt protocol writes scratch prompt/output
// files under these prefixes; they are not scope violations. Logs likewise.
const ALLOWED_WRITE_PREFIXES = [
  '.forgeroom/prompts/conductor/',
  '.forgeroom/outputs/conductor/',
  '.forgeroom/logs/',
];

function isAllowedWrite(rel: string): boolean {
  const normalized = normalizeRel(rel);
  if (ALLOWED_WRITE_PATHS.has(normalized)) {
    return true;
  }
  return ALLOWED_WRITE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

const EMPTY_SUMMARY = '# Task Summary\n';
const EMPTY_FEEDBACK = '# User Feedback\n\n## Pending for Next Step\n\n## Applied\n';

const PENDING_HEADING = '## Pending for Next Step';
const APPLIED_HEADING = '## Applied';

export class FileConductor implements Conductor {
  private readonly agent: ConductorAgent;
  private readonly git: ConductorGit;
  private readonly taskStore: Pick<TaskStore, 'getTask' | 'upsertConductorState'>;
  private readonly maxSummaryChars: number;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;

  constructor(deps: ConductorDeps) {
    this.agent = deps.agent;
    this.git = deps.git;
    this.taskStore = deps.taskStore;
    this.maxSummaryChars = (deps.maxSummaryTokens ?? DEFAULT_MAX_SUMMARY_TOKENS) * CHARS_PER_TOKEN;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? ((line) => process.stderr.write(`${line}\n`));
  }

  async init(taskId: string): Promise<void> {
    const worktree = await this.requireWorktree(taskId);
    await mkdir(path.join(worktree, CONTEXT_DIR), { recursive: true });
    await writeIfMissing(path.join(worktree, SUMMARY_FS_REL), EMPTY_SUMMARY);
    await writeIfMissing(path.join(worktree, FEEDBACK_FS_REL), EMPTY_FEEDBACK);
    await this.taskStore.upsertConductorState(taskId, EMPTY_SUMMARY, SUMMARY_REL, null);
  }

  /**
   * ADR-016: must commit summary.md/feedback.md to disk BEFORE returning so a
   * later Mastra suspend/resume always finds them. Every write below is awaited
   * before this promise resolves; the caller's `await` is the ordering barrier
   * relative to the suspend gate. We never spawn detached/pending writes.
   */
  async update(taskId: string, stepResult: StepResult): Promise<void> {
    const worktree = await this.requireWorktree(taskId);
    const summaryPath = path.join(worktree, SUMMARY_FS_REL);
    const feedbackPath = path.join(worktree, FEEDBACK_FS_REL);

    const currentSummary = await readOr(summaryPath, EMPTY_SUMMARY);
    const prompt = buildUpdatePrompt(currentSummary, stepResult);

    const result = await this.guardedRun({
      taskId,
      callKind: 'update',
      prompt,
      cwd: worktree,
    });

    const nextSummary = this.truncateSummary(
      result.failed || result.text.trim() === '' ? currentSummary : result.text,
    );

    // Code-owned Pending->Applied transition (deterministic, not LLM-trusted).
    // Only on step success do we promote pending feedback to Applied.
    if (stepResult.status === 'done') {
      const feedback = await readOr(feedbackPath, EMPTY_FEEDBACK);
      const promoted = promotePendingToApplied(feedback, stepResult.stepId);
      if (promoted !== feedback) {
        await writeFile(feedbackPath, promoted);
      }
    }

    await writeFile(summaryPath, nextSummary);
    await this.taskStore.upsertConductorState(taskId, nextSummary, SUMMARY_REL, stepResult.stepId);
  }

  async integrateFeedback(taskId: string): Promise<void> {
    const worktree = await this.requireWorktree(taskId);
    const summaryPath = path.join(worktree, SUMMARY_FS_REL);
    const feedbackPath = path.join(worktree, FEEDBACK_FS_REL);

    const summary = await readOr(summaryPath, EMPTY_SUMMARY);
    const feedback = await readOr(feedbackPath, EMPTY_FEEDBACK);
    const prompt = buildIntegrateFeedbackPrompt(summary, feedback);

    const result = await this.guardedRun({
      taskId,
      callKind: 'integrateFeedback',
      prompt,
      cwd: worktree,
    });

    if (result.failed || result.text.trim() === '') {
      // Graceful degradation: keep existing feedback.md, do not block the step.
      return;
    }

    // Code owns section structure: append the agent's text as Pending bullets.
    const next = appendPending(feedback, result.text);
    await writeFile(feedbackPath, next);
  }

  async refine(taskId: string, stepId: string, basePrompt: string): Promise<string> {
    const worktree = await this.requireWorktree(taskId);
    const summary = await readOr(path.join(worktree, SUMMARY_FS_REL), EMPTY_SUMMARY);
    const feedback = await readOr(path.join(worktree, FEEDBACK_FS_REL), EMPTY_FEEDBACK);
    const prompt = buildRefinePrompt({ summary, feedback, stepId, basePrompt });

    const result = await this.guardedRun({
      taskId,
      callKind: 'refine',
      prompt,
      cwd: worktree,
    });

    // Graceful degradation: fall back to the base prompt as-is.
    if (result.failed || result.text.trim() === '') {
      return basePrompt;
    }

    return result.text;
  }

  async answer(taskId: string, question: string): Promise<string> {
    const worktree = await this.requireWorktree(taskId);
    const summary = await readOr(path.join(worktree, SUMMARY_FS_REL), EMPTY_SUMMARY);
    const prompt = buildAnswerPrompt(summary, question);

    const result = await this.guardedRun({
      taskId,
      callKind: 'answer',
      prompt,
      cwd: worktree,
    });

    if (result.failed) {
      return 'answer failed; please inspect .forgeroom/context/summary.md directly.';
    }

    return result.text;
  }

  /**
   * Runs the agent with a post-run scope guard: snapshots git status before the
   * call, diffs after, reverts anything outside the allowed files, logs the
   * violation, and ALWAYS keeps the agent's text output (conductor.md spec).
   */
  private async guardedRun(input: {
    taskId: string;
    callKind: 'refine' | 'update' | 'integrateFeedback' | 'answer';
    prompt: string;
    cwd: string;
  }): Promise<ConductorAgentResult> {
    const before = new Set(await this.git.status(input.cwd));

    const result = await this.agent.run(input);

    const after = await this.git.status(input.cwd);
    const violations = after.filter((rel) => !before.has(rel) && !isAllowedWrite(rel));

    if (violations.length > 0) {
      await this.git.revert(input.cwd, violations);
      await this.recordScopeViolation(input.cwd, input.taskId, input.callKind, violations);
    }

    return result;
  }

  private async recordScopeViolation(
    cwd: string,
    taskId: string,
    callKind: string,
    violations: string[],
  ): Promise<void> {
    const logPath = path.join(cwd, SCOPE_VIOLATION_LOG_REL);
    await mkdir(path.dirname(logPath), { recursive: true });
    const line = `${this.now().toISOString()} task=${taskId} call=${callKind} reverted=${violations.join(',')}`;
    await appendFile(logPath, `${line}\n`);
    this.log(`conductor scope violation: ${line}`);
  }

  private truncateSummary(summary: string): string {
    if (summary.length <= this.maxSummaryChars) {
      return summary;
    }

    // Hard cap: the result (head + marker) must never exceed the budget. When
    // the budget is too small to fit the marker, fall back to a bare head slice.
    if (this.maxSummaryChars <= TRUNCATION_MARKER.length) {
      return summary.slice(0, this.maxSummaryChars);
    }
    const headBudget = this.maxSummaryChars - TRUNCATION_MARKER.length;
    return summary.slice(0, headBudget) + TRUNCATION_MARKER;
  }

  private async requireWorktree(taskId: string): Promise<string> {
    const task: Task | null = await this.taskStore.getTask(taskId);
    if (!task) {
      throw new Error(`conductor: unknown task ${taskId}`);
    }

    return task.worktree_path;
  }
}

function normalizeRel(rel: string): string {
  return rel.split(path.sep).join('/');
}

async function writeIfMissing(filePath: string, content: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    await writeFile(filePath, content);
  }
}

async function readOr(filePath: string, fallback: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return fallback;
  }
}

/**
 * Promote every "## Pending for Next Step" bullet into "## Applied" tagged with
 * the consuming step id. Pure string transform so the transition is testable
 * without trusting the LLM. Returns input unchanged when there is nothing to do.
 */
export function promotePendingToApplied(feedback: string, stepId: string): string {
  const sections = splitFeedbackSections(feedback);
  if (sections.pending.length === 0) {
    return feedback;
  }

  const newlyApplied = sections.pending.map((item) => `- [step: ${stepId}] ${stripBullet(item)}`);
  const applied = [...sections.applied, ...newlyApplied];

  return renderFeedback([], applied);
}

function appendPending(feedback: string, agentText: string): string {
  const sections = splitFeedbackSections(feedback);
  const newItems = bulletsFromText(agentText);
  if (newItems.length === 0) {
    return feedback;
  }

  return renderFeedback([...sections.pending, ...newItems], sections.applied);
}

interface FeedbackSections {
  pending: string[];
  applied: string[];
}

function splitFeedbackSections(feedback: string): FeedbackSections {
  const lines = feedback.split('\n');
  const pending: string[] = [];
  const applied: string[] = [];
  let current: 'none' | 'pending' | 'applied' = 'none';

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === PENDING_HEADING) {
      current = 'pending';
      continue;
    }
    if (trimmed === APPLIED_HEADING) {
      current = 'applied';
      continue;
    }
    if (!trimmed.startsWith('- ')) {
      continue;
    }
    if (current === 'pending') {
      pending.push(trimmed);
    } else if (current === 'applied') {
      applied.push(trimmed);
    }
  }

  return { pending, applied };
}

function renderFeedback(pending: string[], applied: string[]): string {
  const pendingBlock = pending.length > 0 ? `${pending.join('\n')}\n` : '';
  const appliedBlock = applied.length > 0 ? `${applied.join('\n')}\n` : '';

  return `# User Feedback\n\n${PENDING_HEADING}\n${pendingBlock}\n${APPLIED_HEADING}\n${appliedBlock}`;
}

function bulletsFromText(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- ') && stripBullet(line) !== '');
}

function stripBullet(line: string): string {
  return line.replace(/^-\s+/, '').trim();
}

function buildUpdatePrompt(summary: string, stepResult: StepResult): string {
  return [
    '[CONTEXT]',
    '- Existing summary:',
    summary,
    `- Just-finished step: ${stepResult.stepId} (status: ${stepResult.status})`,
    `- prompt: ${stepResult.promptPath}`,
    `- output: ${stepResult.outputPath}`,
    `- diff: ${stepResult.diffPath ?? '(none)'}`,
    '',
    '[INSTRUCTION]',
    'Update the task summary. Max 4000 tokens. Output the full updated summary markdown only.',
  ].join('\n');
}

function buildIntegrateFeedbackPrompt(summary: string, feedback: string): string {
  return [
    '[CONTEXT]',
    '- Existing summary:',
    summary,
    '- Existing feedback document:',
    feedback,
    '',
    '[INSTRUCTION]',
    'Summarize the not-yet-applied user feedback as a list of "- " bullets for the next step.',
    'Output bullets only. Do not overwrite step outputs.',
  ].join('\n');
}

function buildRefinePrompt(input: {
  summary: string;
  feedback: string;
  stepId: string;
  basePrompt: string;
}): string {
  return [
    '[CONTEXT]',
    '- Accumulated summary:',
    input.summary,
    '- Integrated feedback:',
    input.feedback,
    `- Current step: ${input.stepId}`,
    '- Base prompt:',
    input.basePrompt,
    '',
    '[INSTRUCTION]',
    'Augment this step base_prompt with task context. Do not change the original intent;',
    'add specificity and rationale. Output the augmented prompt only.',
  ].join('\n');
}

function buildAnswerPrompt(summary: string, question: string): string {
  return [
    '[CONTEXT]',
    '- Summary:',
    summary,
    `- User question: ${question}`,
    '',
    '[INSTRUCTION]',
    'Answer factually. If you do not know, say so.',
  ].join('\n');
}

/**
 * Production ConductorGit backed by the git CLI. `status` returns the porcelain
 * change set (worktree-relative); `revert` restores tracked files to HEAD and
 * deletes untracked files. Untracked files are not restorable by `git restore`,
 * so they must be removed explicitly.
 */
export class GitCliConductorGit implements ConductorGit {
  async status(cwd: string): Promise<string[]> {
    // --untracked-files=all lists individual untracked files rather than
    // collapsing them under a directory entry, so the scope guard can revert
    // (delete) each offending file precisely.
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain', '--untracked-files=all', '-z'],
      { cwd },
    );
    return parsePorcelainZ(stdout);
  }

  async revert(cwd: string, paths: string[]): Promise<void> {
    if (paths.length === 0) {
      return;
    }

    // Restore tracked files to HEAD. Files that are untracked are ignored here
    // (git restore errors on pathspec-only-untracked), so we also rm each path.
    try {
      await execFileAsync('git', ['restore', '--source=HEAD', '--worktree', '--', ...paths], { cwd });
    } catch {
      // Path may be entirely untracked (no HEAD entry); the rm below handles it.
    }

    await Promise.all(
      paths.map(async (rel) => {
        // Re-running restore can resurrect tracked content; for untracked files
        // we delete. We only delete files that are still present and untracked.
        const isTracked = await pathIsTracked(cwd, rel);
        if (!isTracked) {
          await rm(path.join(cwd, rel), { force: true, recursive: true });
        }
      }),
    );
  }
}

async function pathIsTracked(cwd: string, rel: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['ls-files', '--error-unmatch', '--', rel], { cwd });
    return true;
  } catch {
    return false;
  }
}

function parsePorcelainZ(stdout: string): string[] {
  // `-z` records are NUL-separated; each entry is "XY <path>". Renames carry an
  // extra NUL-separated origin path which we skip.
  const records = stdout.split('\0').filter((r) => r.length > 0);
  const paths: string[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record === undefined || record.length < 4) {
      continue;
    }
    const status = record.slice(0, 2);
    const file = record.slice(3);
    paths.push(file);
    if (status[0] === 'R' || status[1] === 'R') {
      i += 1; // skip the rename origin path
    }
  }
  return paths;
}

/**
 * Production ConductorAgent backed by AgentRunner using the file-based prompt
 * protocol: write prompt -> run agent -> read its output file. The agent is
 * instructed to write only to the output file; the FileConductor scope guard
 * reverts anything else.
 */
export interface AgentRunnerConductorAgentOptions {
  agentRunner: AgentRunner;
  agentId: string;
  createCallId?: () => string;
}

export class AgentRunnerConductorAgent implements ConductorAgent {
  private readonly agentRunner: AgentRunner;
  private readonly agentId: string;
  private readonly createCallId: () => string;

  constructor(options: AgentRunnerConductorAgentOptions) {
    this.agentRunner = options.agentRunner;
    this.agentId = options.agentId;
    this.createCallId = options.createCallId ?? (() => `${Date.now().toString()}`);
  }

  async run(input: {
    taskId: string;
    callKind: 'refine' | 'update' | 'integrateFeedback' | 'answer';
    prompt: string;
    cwd: string;
  }): Promise<ConductorAgentResult> {
    const callId = this.createCallId();
    const base = path.join('.forgeroom', 'prompts', 'conductor', `${input.callKind}.${callId}`);
    const promptPath = path.join(input.cwd, `${base}.prompt.md`);
    const outputPath = path.join(input.cwd, `${base}.output.md`);
    const stdoutPath = path.join(input.cwd, `${base}.stdout.log`);
    const stderrPath = path.join(input.cwd, `${base}.stderr.log`);

    await mkdir(path.dirname(promptPath), { recursive: true });
    await writeFile(promptPath, input.prompt);

    const result = await this.agentRunner.run({
      agentId: this.agentId,
      promptPath,
      outputPath,
      stdoutPath,
      stderrPath,
      cwd: input.cwd,
      mode: 'headless',
    });

    if (result.failureKind !== undefined || !result.outputExists) {
      return { text: '', failed: true };
    }

    const text = await readOr(outputPath, '');
    return { text, failed: false };
  }
}
