export const TASK_STATUSES = ['queued', 'running', 'paused', 'done', 'failed', 'canceled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const STEP_STATUSES = ['pending', 'running', 'paused', 'done', 'failed'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const CHECK_STATUSES = ['not_run', 'passed', 'failed', 'fixed'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export type TaskSource = 'discord-command' | 'github-issue-label';

export interface ExternalRef {
  provider: string;
  id: string;
  url?: string;
  title?: string;
  status_comment_id?: string;
  status_message_id?: string;
  /** Discord per-task thread id (Phase 2A); paired with status_message_id. */
  status_thread_id?: string;
}

export interface Task {
  id: string;
  project_id: string;
  workflow_id: string;
  title: string;
  description: string;
  status: TaskStatus;
  failure_reason: OrchestratorFailureCode | null;
  source: TaskSource;
  external_ref: ExternalRef | null;
  issue_number: number | null;
  branch_name: string;
  worktree_path: string;
  pr_number: number | null;
  final_slices: string[];
  vars: Record<string, string>;
  // ADR-017: nullable pointer to the auxiliary Mastra workflow run. The
  // TaskStore step rows remain authoritative; recoverPending() reads this to
  // pick Mastra run resume vs. a fresh reconstructed run. Null = fresh run.
  mastra_run_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface Step {
  id: string;
  task_id: string;
  step_id: string;
  parent_step_id: string | null;
  iteration: number;
  agent_id: string;
  status: StepStatus;
  failure_reason: OrchestratorFailureCode | null;
  attempt: number;
  check_fix_attempt: number;
  check_status: CheckStatus;
  prompt_path: string;
  output_path: string;
  diff_path: string | null;
  exit_code: number | null;
  started_at: Date;
  finished_at: Date | null;
  /**
   * OpenClaw session handles (ADR-028 Project Room). Nullable resume HINTS —
   * NOT authority (ADR-017): never consulted to decide next step, success, or
   * output truth. `openclaw_session_id` is the runtime-assigned resume id;
   * `openclaw_agent_key` the provider-native agent driven; `openclaw_role` the
   * Project Room role.
   */
  openclaw_session_id: string | null;
  openclaw_agent_key: string | null;
  openclaw_role: string | null;
}

export interface Check {
  id: string;
  step_row_id: string;
  check_fix_attempt: number;
  command_name: string;
  command: string;
  exit_code: number;
  stdout_path: string;
  stderr_path: string;
  duration_ms: number;
  created_at: Date;
}

export interface Event {
  id: string;
  task_id: string;
  type: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

export interface ConductorState {
  task_id: string;
  summary: string;
  last_step_id: string | null;
  summary_path: string;
  last_updated: Date;
}

export interface StepResult {
  stepId: string;
  promptPath: string;
  outputPath: string;
  diffPath: string | null;
  status: StepStatus;
}

export interface Conductor {
  init(taskId: string): Promise<void>;
  // ADR-016: synchronous — summary.md/feedback.md are committed to disk before
  // the returned promise resolves, so a later Mastra suspend/resume finds them.
  update(taskId: string, stepResult: StepResult): Promise<void>;
  integrateFeedback(taskId: string): Promise<void>;
  refine(taskId: string, stepId: string, basePrompt: string): Promise<string>;
  answer(taskId: string, question: string): Promise<string>;
}

export interface EventDelivery {
  id: string;
  event_id: string;
  destination: 'discord' | 'github';
  delivery_attempts: number;
  next_delivery_at: Date | null;
  last_delivery_error: string | null;
  delivered_at: Date | null;
  created_at: Date;
}

export interface CheckResult {
  commandName: string;
  command: string;
  exitCode: number;
  durationMs: number;
  stdoutPath: string;
  stderrPath: string;
}

export interface CheckRunResult {
  allPassed: boolean;
  results: CheckResult[];
}

export type ReporterEvent =
  | { type: 'task_started'; task: Task }
  | { type: 'step_done'; task: Task; step: Step }
  | { type: 'check_result'; task: Task; results: CheckResult[] }
  | { type: 'user_feedback'; task: Task; message: string }
  | { type: 'feedback_integrated'; task: Task; feedbackPath: string }
  | { type: 'feedback_integration_failed'; task: Task; failure_reason: string }
  | { type: 'context_stale_blocked'; task: Task; dirtyFiles: string[] }
  | { type: 'dirty_baseline_approved'; task: Task; approvedBy: string }
  | { type: 'pr_created'; task: Task; pr_number: number; pr_url: string }
  | { type: 'task_done_no_diff'; task: Task }
  | { type: 'task_failed'; task: Task; failure_reason: string }
  | { type: 'task_canceled'; task: Task }
  | { type: 'ask_response'; task: Task; question: string; answer: string };

/** The delivery destinations a ReporterSink can target (ADR-013). */
export type ReporterDestination = 'discord' | 'github';

/**
 * Opaque provider id of the single per-task status surface (ADR-013): a Discord
 * status message id, or a GitHub status-comment id. Persisted in
 * `tasks.external_ref` so re-delivery edits the same surface (idempotency).
 */
export interface StatusSurfaceRef {
  id: string;
  /**
   * Discord per-task thread id (Phase 2A). When set, the status message lives
   * in this thread (a channel id in discord.js terms), not the bare project
   * channel. Persisted so re-delivery edits the same message in the same
   * thread. Absent for GitHub surfaces and pre-thread Discord surfaces.
   */
  threadId?: string;
}

/**
 * What a sink reports back after delivering an event. `surface` is the
 * (possibly newly created) status-surface id the Reporter must persist so the
 * NEXT delivery edits the same surface instead of creating a duplicate. A sink
 * that touches no durable status surface for an event (e.g. `report: none`)
 * returns the surface it was given unchanged (or null).
 */
export interface DeliveryOutcome {
  surface: StatusSurfaceRef | null;
}

/**
 * Input handed to a per-destination sink for one delivery attempt. `surface` is
 * the current persisted surface id for the task (null on first delivery); the
 * sink edits it when present and creates-then-returns one when absent.
 */
export interface DeliveryRequest {
  event: ReporterEvent;
  surface: StatusSurfaceRef | null;
}

/**
 * Reporter facade (ADR-013). The PipelineEngine fires `notify(event)` AFTER the
 * authoritative TaskStore commit; `flushUndelivered()` re-attempts due, not-yet
 * delivered outbox rows on restart. Delivery is best-effort and never fails the
 * task.
 */
export interface Reporter {
  notify(event: ReporterEvent): Promise<void>;
  flushUndelivered(): Promise<void>;
}

/**
 * Per-destination delivery sink (ADR-013). Real impls (DiscordReporterSink /
 * GitHubReporterSink) talk to discord.js / Octokit behind interface adapters.
 * `deliver` is idempotent on the surface: given a non-null surface it edits it;
 * given null it creates one and returns its id. Reporter never creates PRs —
 * `pr_created` is consumed to update the PR comment/body (ADR-019).
 */
export interface ReporterSink {
  destination: ReporterDestination;
  deliver(request: DeliveryRequest): Promise<DeliveryOutcome>;
}

/**
 * What a TaskSource (Discord/GitHub gateway) produces and hands to the
 * orchestrator (ADR-013). The composition root maps this onto
 * `PipelineEngine.runFull(projectId, TaskInput, RunOpts)`. Kept self-contained
 * here (no import from pipeline-engine.ts) so `core/types.ts` stays
 * dependency-free and gateways can consume it (gateway -> core).
 */
export interface TaskRequest {
  projectId: string;
  /** Selected workflow id within the project's allowed_workflows; omit for project default. */
  workflowId?: string;
  title: string;
  description: string;
  source: Task['source'];
  externalRef?: ExternalRef | null;
  issueNumber?: number | null;
  vars?: Record<string, string>;
}

export function isTaskStatus(value: string): value is TaskStatus {
  return TASK_STATUSES.includes(value as TaskStatus);
}
import type { OrchestratorFailureCode } from './errors.js';
