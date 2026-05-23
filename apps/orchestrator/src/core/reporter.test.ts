/**
 * Reporter unit tests (#25). Covers the outbox/retry model over event_deliveries,
 * idempotent single-surface delivery, best-effort failure (task never fails),
 * flushUndelivered, and that the GitHub/Discord sinks update an existing surface
 * (edit-or-followup) and never create PRs. Real discord.js/Octokit calls are
 * exercised behind interface fakes.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  OutboxReporter,
  DiscordReporterSink,
  GitHubReporterSink,
  REPORTER_MAX_ATTEMPTS,
  type ReporterStore,
  type DiscordStatusClient,
  type GitHubStatusClient,
} from './reporter.js';
import type {
  DeliveryRequest,
  DeliveryOutcome,
  Event,
  EventDelivery,
  ReporterEvent,
  ReporterSink,
  Step,
  Task,
} from './types.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    project_id: 'proj',
    workflow_id: 'mvp',
    title: 'Add widget',
    description: 'do it',
    status: 'running',
    failure_reason: null,
    source: 'github-issue-label',
    external_ref: { provider: 'github', id: '42', url: 'https://x/42' },
    issue_number: 42,
    branch_name: 'feat/task-1',
    worktree_path: '/wt/task-1',
    pr_number: null,
    final_slices: [],
    vars: {},
    mastra_run_id: null,
    created_at: new Date('2026-05-23T00:00:00Z'),
    updated_at: new Date('2026-05-23T00:00:00Z'),
    ...overrides,
  };
}

/** In-memory ReporterStore capturing the outbox + external_ref writes. */
class FakeReporterStore implements ReporterStore {
  events: Event[] = [];
  deliveries: EventDelivery[] = [];
  task: Task;
  private seq = 0;

  constructor(task: Task) {
    this.task = task;
  }

  getTask(id: string): Promise<Task | null> {
    return Promise.resolve(id === this.task.id ? this.task : null);
  }

  enqueueEvent(input: Event): Promise<Event> {
    this.events.push(input);
    return Promise.resolve(input);
  }

  enqueueEventDelivery(input: {
    id: string;
    event_id: string;
    destination: 'discord' | 'github';
  }): Promise<EventDelivery> {
    const delivery: EventDelivery = {
      id: input.id,
      event_id: input.event_id,
      destination: input.destination,
      delivery_attempts: 0,
      next_delivery_at: null,
      last_delivery_error: null,
      delivered_at: null,
      created_at: new Date(),
    };
    this.deliveries.push(delivery);
    return Promise.resolve(delivery);
  }

  markDeliveryDelivered(id: string): Promise<void> {
    const d = this.deliveries.find((x) => x.id === id);
    if (d !== undefined) {
      d.delivered_at = new Date();
    }
    return Promise.resolve();
  }

  markDeliveryFailed(
    id: string,
    patch: { delivery_attempts: number; next_delivery_at: Date | null; last_delivery_error: string | null },
  ): Promise<void> {
    const d = this.deliveries.find((x) => x.id === id);
    if (d !== undefined) {
      d.delivery_attempts = patch.delivery_attempts;
      d.next_delivery_at = patch.next_delivery_at;
      d.last_delivery_error = patch.last_delivery_error;
    }
    return Promise.resolve();
  }

  listDueUndeliveredDeliveries(now: Date): Promise<EventDelivery[]> {
    return Promise.resolve(
      this.deliveries.filter(
        (d) =>
          d.delivered_at === null && (d.next_delivery_at === null || d.next_delivery_at <= now),
      ),
    );
  }

  getEvent(id: string): Promise<Event | null> {
    return Promise.resolve(this.events.find((e) => e.id === id) ?? null);
  }

  setExternalRef(taskId: string, ref: Task['external_ref']): Promise<void> {
    if (taskId === this.task.id) {
      this.task = { ...this.task, external_ref: ref };
    }
    return Promise.resolve();
  }

  nextId(): string {
    this.seq += 1;
    return `id-${this.seq}`;
  }
}

/** A sink that records calls and emits a stable surface id (edit-or-followup). */
function recordingSink(destination: 'discord' | 'github'): ReporterSink & {
  calls: DeliveryRequest[];
} {
  const calls: DeliveryRequest[] = [];
  return {
    destination,
    calls,
    deliver(request: DeliveryRequest): Promise<DeliveryOutcome> {
      calls.push(request);
      // Idempotent: reuse the surface it was given, otherwise mint one.
      const surface = request.surface ?? { id: `${destination}-surface-1` };
      return Promise.resolve({ surface });
    },
  };
}

const ZERO_BACKOFF = (): number => 0;

// ---------------------------------------------------------------------------
// notify: outbox + delivery
// ---------------------------------------------------------------------------

describe('OutboxReporter.notify', () => {
  it('persists the domain event and one delivery for the TaskSource destination', async () => {
    const store = new FakeReporterStore(makeTask({ source: 'github-issue-label' }));
    const github = recordingSink('github');
    const reporter = new OutboxReporter({
      store,
      sinks: [github],
      now: () => new Date('2026-05-23T01:00:00Z'),
      newId: () => store.nextId(),
    });

    await reporter.notify({ type: 'task_started', task: store.task });

    expect(store.events).toHaveLength(1);
    expect(store.events[0]?.type).toBe('task_started');
    expect(store.deliveries).toHaveLength(1);
    expect(store.deliveries[0]?.destination).toBe('github');
    expect(store.deliveries[0]?.delivered_at).not.toBeNull();
    expect(github.calls).toHaveLength(1);
  });

  it('routes Discord-command tasks to the Discord sink', async () => {
    const store = new FakeReporterStore(makeTask({ source: 'discord-command' }));
    const discord = recordingSink('discord');
    const github = recordingSink('github');
    const reporter = new OutboxReporter({
      store,
      sinks: [discord, github],
      newId: () => store.nextId(),
    });

    await reporter.notify({ type: 'task_started', task: store.task });

    expect(discord.calls).toHaveLength(1);
    expect(github.calls).toHaveLength(0);
    expect(store.deliveries[0]?.destination).toBe('discord');
  });

  it('persists the surface id into external_ref so re-delivery edits the same surface', async () => {
    const store = new FakeReporterStore(makeTask({ source: 'github-issue-label' }));
    const github = recordingSink('github');
    const reporter = new OutboxReporter({ store, sinks: [github], newId: () => store.nextId() });

    await reporter.notify({ type: 'task_started', task: store.task });
    // The first delivery had no surface; the minted id is now persisted.
    expect(store.task.external_ref?.status_comment_id).toBe('github-surface-1');

    await reporter.notify({ type: 'step_done', task: store.task, step: fakeStep() });
    // Second delivery is handed the SAME surface — no duplicate surface created.
    expect(github.calls[1]?.surface).toEqual({ id: 'github-surface-1' });
  });
});

// ---------------------------------------------------------------------------
// Best-effort failure: never fails the task, leaves delivery undelivered.
// ---------------------------------------------------------------------------

describe('OutboxReporter delivery failure', () => {
  it('leaves the delivery undelivered with backoff and does NOT throw', async () => {
    const store = new FakeReporterStore(makeTask({ source: 'github-issue-label' }));
    const failing: ReporterSink = {
      destination: 'github',
      deliver: () => Promise.reject(new Error('rate limited')),
    };
    const logs: string[] = [];
    const reporter = new OutboxReporter({
      store,
      sinks: [failing],
      newId: () => store.nextId(),
      backoffMs: ZERO_BACKOFF,
      log: (l) => logs.push(l),
    });

    await expect(reporter.notify({ type: 'task_started', task: store.task })).resolves.toBeUndefined();

    const delivery = store.deliveries[0];
    expect(delivery?.delivered_at).toBeNull();
    expect(delivery?.delivery_attempts).toBe(1);
    expect(delivery?.next_delivery_at).not.toBeNull();
    expect(delivery?.last_delivery_error).toContain('rate limited');
  });

  it('stops retrying after REPORTER_MAX_ATTEMPTS and logs locally', async () => {
    const store = new FakeReporterStore(makeTask({ source: 'github-issue-label' }));
    const failing: ReporterSink = {
      destination: 'github',
      deliver: () => Promise.reject(new Error('boom')),
    };
    const logs: string[] = [];
    const reporter = new OutboxReporter({
      store,
      sinks: [failing],
      newId: () => store.nextId(),
      backoffMs: ZERO_BACKOFF,
      log: (l) => logs.push(l),
    });

    await reporter.notify({ type: 'task_started', task: store.task });
    // Retry to exhaustion via flush.
    for (let i = 0; i < REPORTER_MAX_ATTEMPTS + 2; i += 1) {
      await reporter.flushUndelivered();
    }

    const delivery = store.deliveries[0];
    expect(delivery?.delivered_at).toBeNull();
    expect(delivery?.delivery_attempts).toBe(REPORTER_MAX_ATTEMPTS);
    // A permanently-failed delivery is no longer due (parked).
    expect(delivery?.next_delivery_at).toBeNull();
    expect(logs.some((l) => l.includes('giving up'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// flushUndelivered: restart re-delivery.
// ---------------------------------------------------------------------------

describe('OutboxReporter.flushUndelivered', () => {
  it('re-delivers a due undelivered row and marks it delivered', async () => {
    const store = new FakeReporterStore(makeTask({ source: 'github-issue-label' }));
    let fail = true;
    const flaky: ReporterSink = {
      destination: 'github',
      deliver: (req): Promise<DeliveryOutcome> => {
        if (fail) {
          fail = false;
          return Promise.reject(new Error('transient'));
        }
        return Promise.resolve({ surface: req.surface ?? { id: 'github-surface-1' } });
      },
    };
    const reporter = new OutboxReporter({
      store,
      sinks: [flaky],
      newId: () => store.nextId(),
      backoffMs: ZERO_BACKOFF,
    });

    await reporter.notify({ type: 'task_started', task: store.task });
    expect(store.deliveries[0]?.delivered_at).toBeNull();

    await reporter.flushUndelivered();
    expect(store.deliveries[0]?.delivered_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// pr_created: consumed, no PR creation.
// ---------------------------------------------------------------------------

describe('OutboxReporter pr_created', () => {
  it('consumes pr_created to update the surface and never creates a PR', async () => {
    const store = new FakeReporterStore(
      makeTask({ source: 'github-issue-label', pr_number: 7 }),
    );
    const github = recordingSink('github');
    const reporter = new OutboxReporter({ store, sinks: [github], newId: () => store.nextId() });

    const event: ReporterEvent = {
      type: 'pr_created',
      task: store.task,
      pr_number: 7,
      pr_url: 'https://github.com/o/r/pull/7',
    };
    await reporter.notify(event);

    expect(github.calls).toHaveLength(1);
    expect(github.calls[0]?.event.type).toBe('pr_created');
    // The recording sink has no createPR capability; the Reporter never asked.
  });
});

// ---------------------------------------------------------------------------
// Real sinks behind interface fakes.
// ---------------------------------------------------------------------------

describe('GitHubReporterSink (Octokit behind a fake client)', () => {
  it('creates a status comment on first delivery and edits it thereafter', async () => {
    const created = vi.fn().mockResolvedValue({ id: '555' });
    const updated = vi.fn().mockResolvedValue(undefined);
    const client: GitHubStatusClient = {
      createIssueComment: created,
      updateIssueComment: updated,
      updatePrComment: vi.fn().mockResolvedValue(undefined),
    };
    const sink = new GitHubReporterSink(client);
    const task = makeTask({ source: 'github-issue-label', issue_number: 42 });

    const first = await sink.deliver({
      event: { type: 'task_started', task },
      surface: null,
    });
    expect(created).toHaveBeenCalledTimes(1);
    expect(first.surface).toEqual({ id: '555' });

    await sink.deliver({ event: { type: 'step_done', task, step: fakeStep() }, surface: first.surface });
    expect(updated).toHaveBeenCalledTimes(1);
    expect(created).toHaveBeenCalledTimes(1);
  });

  it('updates the PR comment on pr_created without creating a PR', async () => {
    const updatePr = vi.fn().mockResolvedValue(undefined);
    const client: GitHubStatusClient = {
      createIssueComment: vi.fn().mockResolvedValue({ id: '1' }),
      updateIssueComment: vi.fn().mockResolvedValue(undefined),
      updatePrComment: updatePr,
    };
    const sink = new GitHubReporterSink(client);
    const task = makeTask({ source: 'github-issue-label', pr_number: 7 });

    await sink.deliver({
      event: { type: 'pr_created', task, pr_number: 7, pr_url: 'https://x/7' },
      surface: { id: '555' },
    });
    expect(updatePr).toHaveBeenCalledTimes(1);
  });
});

describe('DiscordReporterSink (discord.js behind a fake client)', () => {
  it('sends a status message first then edits it (edit-or-followup)', async () => {
    const send = vi.fn().mockResolvedValue({ id: 'msg-9' });
    const edit = vi.fn().mockResolvedValue(undefined);
    const client: DiscordStatusClient = { sendMessage: send, editMessage: edit };
    const sink = new DiscordReporterSink(client);
    const task = makeTask({
      source: 'discord-command',
      external_ref: { provider: 'discord', id: 'chan-1' },
    });

    const first = await sink.deliver({ event: { type: 'task_started', task }, surface: null });
    expect(send).toHaveBeenCalledTimes(1);
    expect(first.surface).toEqual({ id: 'msg-9' });

    await sink.deliver({ event: { type: 'step_done', task, step: fakeStep() }, surface: first.surface });
    expect(edit).toHaveBeenCalledTimes(1);
  });

  it('falls back to a follow-up message when editing the stale surface fails', async () => {
    const send = vi.fn().mockResolvedValue({ id: 'msg-10' });
    const edit = vi.fn().mockRejectedValue(new Error('Unknown Message'));
    const client: DiscordStatusClient = { sendMessage: send, editMessage: edit };
    const sink = new DiscordReporterSink(client);
    const task = makeTask({
      source: 'discord-command',
      external_ref: { provider: 'discord', id: 'chan-1' },
    });

    const outcome = await sink.deliver({
      event: { type: 'step_done', task, step: fakeStep() },
      surface: { id: 'msg-9' },
    });
    expect(edit).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(outcome.surface).toEqual({ id: 'msg-10' });
  });
});

function fakeStep(): Step {
  return {
    id: 'step-1',
    task_id: 'task-1',
    step_id: 'plan',
    parent_step_id: null,
    iteration: 0,
    agent_id: 'planner',
    status: 'done',
    failure_reason: null,
    attempt: 1,
    check_fix_attempt: 0,
    check_status: 'not_run',
    prompt_path: '01_plan.md',
    output_path: '/wt/task-1/.forgeroom/outputs/01_plan.md',
    diff_path: null,
    exit_code: 0,
    started_at: new Date('2026-05-23T00:00:00Z'),
    finished_at: new Date('2026-05-23T00:00:10Z'),
  };
}
