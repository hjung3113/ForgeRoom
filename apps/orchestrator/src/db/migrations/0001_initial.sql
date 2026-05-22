CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'paused', 'done', 'failed', 'canceled')),
  failure_reason TEXT,
  source TEXT NOT NULL CHECK (source IN ('discord-command', 'github-issue-label')),
  external_ref TEXT,
  issue_number INTEGER,
  branch_name TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  pr_number INTEGER,
  vars TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS tasks_project_status_idx
  ON tasks(project_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS tasks_one_active_per_project_idx
  ON tasks(project_id)
  WHERE status IN ('running', 'paused');

CREATE TABLE IF NOT EXISTS steps (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  parent_step_id TEXT REFERENCES steps(id),
  iteration INTEGER NOT NULL DEFAULT 0,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'paused', 'done', 'failed')),
  failure_reason TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  check_fix_attempt INTEGER NOT NULL DEFAULT 0,
  check_status TEXT NOT NULL DEFAULT 'not_run' CHECK (check_status IN ('not_run', 'passed', 'failed', 'fixed')),
  prompt_path TEXT NOT NULL,
  output_path TEXT NOT NULL,
  diff_path TEXT,
  exit_code INTEGER,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS steps_task_started_idx
  ON steps(task_id, started_at);

CREATE TABLE IF NOT EXISTS checks (
  id TEXT PRIMARY KEY NOT NULL,
  step_row_id TEXT NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  check_fix_attempt INTEGER NOT NULL,
  command_name TEXT NOT NULL,
  command TEXT NOT NULL,
  exit_code INTEGER NOT NULL,
  stdout_path TEXT NOT NULL,
  stderr_path TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_deliveries (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  destination TEXT NOT NULL CHECK (destination IN ('discord', 'github')),
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  next_delivery_at TEXT,
  last_delivery_error TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS event_deliveries_due_idx
  ON event_deliveries(delivered_at, next_delivery_at)
  WHERE delivered_at IS NULL;

CREATE TABLE IF NOT EXISTS conductor_state (
  task_id TEXT PRIMARY KEY NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  last_step_id TEXT,
  summary_path TEXT NOT NULL,
  last_updated TEXT NOT NULL
);
