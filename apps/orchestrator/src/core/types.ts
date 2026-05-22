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
}

export interface Task {
  id: string;
  project_id: string;
  workflow_id: string;
  title: string;
  description: string;
  status: TaskStatus;
  failure_reason: string | null;
  source: TaskSource;
  external_ref: ExternalRef | null;
  issue_number: number | null;
  branch_name: string;
  worktree_path: string;
  pr_number: number | null;
  vars: Record<string, string>;
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
  failure_reason: string | null;
  attempt: number;
  check_fix_attempt: number;
  check_status: CheckStatus;
  prompt_path: string;
  output_path: string;
  diff_path: string | null;
  exit_code: number | null;
  started_at: Date;
  finished_at: Date | null;
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
  | { type: 'task_failed'; task: Task; failure_reason: string }
  | { type: 'task_canceled'; task: Task }
  | { type: 'ask_response'; task: Task; question: string; answer: string };

export interface Reporter {
  notify(event: ReporterEvent): Promise<void>;
  flushUndelivered(): Promise<void>;
}

export interface ReporterSink {
  destination: 'discord' | 'github';
  deliver(event: ReporterEvent): Promise<void>;
}

export function isTaskStatus(value: string): value is TaskStatus {
  return TASK_STATUSES.includes(value as TaskStatus);
}
