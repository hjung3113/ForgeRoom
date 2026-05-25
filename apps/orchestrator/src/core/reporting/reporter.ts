/**
 * Reporter (#25) — domain reporting facade + per-destination sinks.
 *
 * The {@link OutboxReporter} persists each {@link ReporterEvent} to the `events`
 * table, opens an `event_deliveries` outbox row for the task's TaskSource
 * destination (ADR-013: Discord-command -> Discord, GitHub-issue-label ->
 * GitHub), then attempts delivery through the matching {@link ReporterSink}.
 * Delivery is BEST-EFFORT: a failed attempt records backoff on the outbox row
 * and the call still resolves — a reporting failure never fails the task
 * (reporter.md). On restart {@link OutboxReporter.flushUndelivered} re-attempts
 * every due, not-yet-delivered row. After {@link REPORTER_MAX_ATTEMPTS} the row
 * is parked (undelivered, no further `next_delivery_at`) and logged locally.
 *
 * Idempotency: there is ONE status surface per task (a Discord status message or
 * a GitHub status comment). Its provider id lives in `tasks.external_ref`
 * (ADR-013); re-delivery hands that id to the sink so it EDITS the same surface
 * instead of creating a duplicate. The minted id is persisted via
 * {@link ReporterStore.setExternalRef}.
 *
 * PR creation is NOT a Reporter concern (ADR-019): the Reporter consumes
 * `pr_created` only to update the PR comment/body. The sinks own no createPR
 * capability.
 *
 * Per core/AGENTS.md the sinks never import `discord.js` / Octokit directly;
 * they talk to the narrow {@link DiscordStatusClient} / {@link GitHubStatusClient}
 * port interfaces whose SDK-backed implementations live in `gateway/`.
 */
import { randomUUID } from 'node:crypto';

import type {
  Event,
  EventDelivery,
  Reporter,
  ReporterDestination,
  ReporterEvent,
  ReporterSink,
  StatusSurfaceRef,
  Task,
} from '../types.js';

// ---------------------------------------------------------------------------
// Retry policy (reporter.md): exponential backoff 1s,2s,4s,8s,16s; cap 5.
// ---------------------------------------------------------------------------

export const REPORTER_MAX_ATTEMPTS = 5;

/** Default backoff: 1s, 2s, 4s, 8s, 16s by (next) attempt number (1-based). */
function defaultBackoffMs(attempt: number): number {
  return 2 ** (attempt - 1) * 1000;
}

// ---------------------------------------------------------------------------
// Narrow persistence capability the Reporter needs (subset of TaskStore plus a
// status-surface writer). Defined here so the Reporter depends on an interface,
// not the full TaskStore, and so the surface-id write has a home without
// touching db/ this wave. The composition root adapts the real TaskStore.
// ---------------------------------------------------------------------------

export interface ReporterStore {
  getTask(id: string): Promise<Task | null>;
  enqueueEvent(input: Event): Promise<Event>;
  enqueueEventDelivery(input: {
    id: string;
    event_id: string;
    destination: ReporterDestination;
  }): Promise<EventDelivery>;
  markDeliveryDelivered(id: string): Promise<void>;
  markDeliveryFailed(
    id: string,
    patch: { delivery_attempts: number; next_delivery_at: Date | null; last_delivery_error: string | null },
  ): Promise<void>;
  listDueUndeliveredDeliveries(now: Date): Promise<EventDelivery[]>;
  getEvent(id: string): Promise<Event | null>;
  /** Persist the per-task status-surface ids back onto `tasks.external_ref`. */
  setExternalRef(taskId: string, ref: Task['external_ref']): Promise<void>;
}

export interface OutboxReporterDeps {
  store: ReporterStore;
  /** One sink per destination; the Reporter picks by TaskSource (ADR-013). */
  sinks: ReporterSink[];
  now?: () => Date;
  newId?: () => string;
  /** Backoff in ms for the upcoming attempt number (1-based). */
  backoffMs?: (attempt: number) => number;
  /** Local log sink for non-task-failing delivery problems. */
  log?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// OutboxReporter
// ---------------------------------------------------------------------------

export class OutboxReporter implements Reporter {
  private readonly store: ReporterStore;
  private readonly sinks: Map<ReporterDestination, ReporterSink>;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly backoffMs: (attempt: number) => number;
  private readonly log: (line: string) => void;

  constructor(deps: OutboxReporterDeps) {
    this.store = deps.store;
    this.sinks = new Map(deps.sinks.map((s) => [s.destination, s]));
    this.now = deps.now ?? ((): Date => new Date());
    this.newId = deps.newId ?? randomUUID;
    this.backoffMs = deps.backoffMs ?? defaultBackoffMs;
    this.log = deps.log ?? ((line): void => void process.stderr.write(`${line}\n`));
  }

  /**
   * Record the event, open an outbox row for the task's destination, and try to
   * deliver it once. Resolves regardless of delivery outcome (best-effort).
   */
  async notify(event: ReporterEvent): Promise<void> {
    const created = this.now();
    const eventRow: Event = {
      id: this.newId(),
      task_id: event.task.id,
      type: event.type,
      payload: toPayload(event),
      created_at: created,
    };
    await this.store.enqueueEvent(eventRow);

    const destination = destinationFor(event.task);
    const delivery = await this.store.enqueueEventDelivery({
      id: this.newId(),
      event_id: eventRow.id,
      destination,
    });

    await this.attempt(delivery, event);
  }

  /**
   * Re-attempt every due, not-yet-delivered outbox row (restart recovery). Each
   * attempt rebuilds the {@link ReporterEvent} from the stored event + current
   * task so the sink sees the latest surface id.
   */
  async flushUndelivered(): Promise<void> {
    const due = await this.store.listDueUndeliveredDeliveries(this.now());
    for (const delivery of due) {
      const event = await this.reconstructEvent(delivery);
      if (event === null) {
        // The event vanished (cascade delete) — the row is orphaned; park it.
        this.log(`reporter: delivery ${delivery.id} has no event; skipping`);
        continue;
      }
      await this.attempt(delivery, event);
    }
  }

  /** One delivery attempt with success/failure bookkeeping. Never throws. */
  private async attempt(delivery: EventDelivery, event: ReporterEvent): Promise<void> {
    // A parked row (already at the attempt cap and undelivered) is terminal: the
    // due query can re-surface it because parked rows carry no next_delivery_at,
    // so guard here rather than re-deliver past the cap.
    if (delivery.delivered_at === null && delivery.delivery_attempts >= REPORTER_MAX_ATTEMPTS) {
      return;
    }

    const sink = this.sinks.get(delivery.destination);
    if (sink === undefined) {
      // No sink wired for this destination (e.g. cross-posting not enabled).
      // Best-effort: park the row so it is not endlessly re-tried.
      await this.parkExhausted(delivery, `no sink for destination ${delivery.destination}`);
      return;
    }

    const surface = this.surfaceFor(event.task, delivery.destination);
    try {
      const outcome = await sink.deliver({ event, surface });
      await this.persistSurface(event.task, delivery.destination, outcome.surface);
      await this.store.markDeliveryDelivered(delivery.id);
    } catch (error) {
      await this.recordFailure(delivery, error);
    }
  }

  private async recordFailure(delivery: EventDelivery, error: unknown): Promise<void> {
    const attempts = delivery.delivery_attempts + 1;
    const message = error instanceof Error ? error.message : String(error);
    if (attempts >= REPORTER_MAX_ATTEMPTS) {
      this.log(
        `reporter: delivery ${delivery.id} (${delivery.destination}) giving up after ${attempts} attempts: ${message}`,
      );
      await this.parkExhausted(delivery, message, attempts);
      return;
    }
    const nextDeliveryAt = new Date(this.now().getTime() + this.backoffMs(attempts + 1));
    await this.store.markDeliveryFailed(delivery.id, {
      delivery_attempts: attempts,
      next_delivery_at: nextDeliveryAt,
      last_delivery_error: message,
    });
  }

  /** Park a row: keep it undelivered but no longer due (no next_delivery_at). */
  private async parkExhausted(
    delivery: EventDelivery,
    message: string,
    attempts = REPORTER_MAX_ATTEMPTS,
  ): Promise<void> {
    await this.store.markDeliveryFailed(delivery.id, {
      delivery_attempts: attempts,
      next_delivery_at: null,
      last_delivery_error: message,
    });
  }

  private surfaceFor(task: Task, destination: ReporterDestination): StatusSurfaceRef | null {
    const ref = task.external_ref;
    if (ref === null) {
      return null;
    }
    const id = destination === 'discord' ? ref.status_message_id : ref.status_comment_id;
    return id === undefined || id === null ? null : { id };
  }

  private async persistSurface(
    task: Task,
    destination: ReporterDestination,
    surface: StatusSurfaceRef | null,
  ): Promise<void> {
    if (surface === null) {
      return;
    }
    const current = task.external_ref;
    const field = destination === 'discord' ? 'status_message_id' : 'status_comment_id';
    if (current !== null && current[field] === surface.id) {
      return; // unchanged
    }
    const base = current ?? { provider: destination, id: surface.id };
    await this.store.setExternalRef(task.id, { ...base, [field]: surface.id });
  }

  private async reconstructEvent(delivery: EventDelivery): Promise<ReporterEvent | null> {
    const event = await this.store.getEvent(delivery.event_id);
    if (event === null) {
      return null;
    }
    const task = await this.store.getTask(event.task_id);
    if (task === null) {
      return null;
    }
    return fromPayload(event.type, task, event.payload);
  }
}

// ---------------------------------------------------------------------------
// Destination selection (ADR-013): driven by TaskSource.
// ---------------------------------------------------------------------------

function destinationFor(task: Task): ReporterDestination {
  return task.source === 'discord-command' ? 'discord' : 'github';
}

// ---------------------------------------------------------------------------
// Event <-> payload (round-trips through the events table for flushUndelivered).
// ---------------------------------------------------------------------------

function toPayload(event: ReporterEvent): Record<string, unknown> {
  const { type: _type, task: _task, ...rest } = event as ReporterEvent & Record<string, unknown>;
  return { ...rest };
}

function fromPayload(
  type: string,
  task: Task,
  payload: Record<string, unknown>,
): ReporterEvent {
  return { type, task, ...payload } as unknown as ReporterEvent;
}

// ---------------------------------------------------------------------------
// Provider-client port interfaces (SDK-backed impls live in gateway/, ADR-013 /
// core/AGENTS.md rule 1). Inputs/outputs are plain primitives — no SDK types.
// ---------------------------------------------------------------------------

export interface DiscordStatusClient {
  /** Post a message to a channel; returns its provider message id. */
  sendMessage(channelId: string, content: string): Promise<{ id: string }>;
  /** Edit an existing message; rejects if the message is gone/stale. */
  editMessage(channelId: string, messageId: string, content: string): Promise<void>;
}

export interface GitHubStatusClient {
  /** Create an issue comment; returns its provider comment id. */
  createIssueComment(issueNumber: number, body: string): Promise<{ id: string }>;
  /** Update an existing issue comment by id. */
  updateIssueComment(commentId: string, body: string): Promise<void>;
  /** Update the PR comment/body for a created PR (no PR creation). */
  updatePrComment(prNumber: number, body: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// DiscordReporterSink — one status message per task; edit-or-followup.
// ---------------------------------------------------------------------------

export class DiscordReporterSink implements ReporterSink {
  readonly destination = 'discord' as const;

  constructor(private readonly client: DiscordStatusClient) {}

  async deliver(request: import('../types.js').DeliveryRequest): Promise<import('../types.js').DeliveryOutcome> {
    const channelId = request.event.task.external_ref?.id;
    if (channelId === undefined) {
      throw new Error('discord delivery requires external_ref.id (channel id)');
    }
    const content = renderDiscord(request.event);

    if (request.surface !== null) {
      try {
        await this.client.editMessage(channelId, request.surface.id, content);
        return { surface: request.surface };
      } catch {
        // Edit failed (message deleted / too old): fall back to a follow-up.
      }
    }
    const sent = await this.client.sendMessage(channelId, content);
    return { surface: { id: sent.id } };
  }
}

// ---------------------------------------------------------------------------
// GitHubReporterSink — pinned status comment per task; updates PR on pr_created.
// ---------------------------------------------------------------------------

export class GitHubReporterSink implements ReporterSink {
  readonly destination = 'github' as const;

  constructor(private readonly client: GitHubStatusClient) {}

  async deliver(request: import('../types.js').DeliveryRequest): Promise<import('../types.js').DeliveryOutcome> {
    const { event, surface } = request;
    const body = renderGitHub(event);

    // pr_created: reflect the final summary on the PR comment/body too. The
    // status comment surface is still maintained below. PR creation is NOT done
    // here (ADR-019) — the PR already exists by the time this event fires.
    if (event.type === 'pr_created') {
      await this.client.updatePrComment(event.pr_number, body);
    }

    const issueNumber = event.task.issue_number;
    if (issueNumber === null) {
      // No issue surface to maintain (e.g. a non-issue task); the PR update (if
      // any) above is the only durable surface.
      return { surface };
    }

    if (surface !== null) {
      await this.client.updateIssueComment(surface.id, body);
      return { surface };
    }
    const created = await this.client.createIssueComment(issueNumber, body);
    return { surface: { id: created.id } };
  }
}

// ---------------------------------------------------------------------------
// Message rendering (MVP levels per reporter.md). Kept minimal and pure.
// ---------------------------------------------------------------------------

const STATUS_MARKER = (taskId: string): string => `<!-- forgeroom:task_id=${taskId} -->`;

function headline(event: ReporterEvent): string {
  const { task } = event;
  return `[task: ${task.id}] ${task.project_id} "${task.title}"`;
}

function bodyLine(event: ReporterEvent): string {
  switch (event.type) {
    case 'task_started':
      return 'started';
    case 'step_done':
      return `done ${event.step.step_id} (${event.step.agent_id}) -> ${event.step.output_path}`;
    case 'check_result': {
      const failed = event.results.filter((r) => r.exitCode !== 0);
      return failed.length === 0
        ? `checks passed (${event.results.length})`
        : `check failed: ${failed.map((r) => r.commandName).join(', ')}`;
    }
    case 'user_feedback':
      return `feedback received: ${event.message}`;
    case 'feedback_integrated':
      return `feedback integrated -> ${event.feedbackPath}`;
    case 'feedback_integration_failed':
      return `feedback integration failed: ${event.failure_reason}`;
    case 'context_stale_blocked':
      return `blocked: dirty baseline (${event.dirtyFiles.length} files)`;
    case 'dirty_baseline_approved':
      return `dirty baseline approved by ${event.approvedBy}`;
    case 'pr_created':
      return `PR created: ${event.pr_url}`;
    case 'task_done_no_diff':
      return 'no changes produced by agent; nothing to PR';
    case 'task_failed':
      return `failed: ${event.failure_reason}`;
    case 'task_canceled':
      return 'canceled';
    case 'ask_response':
      return `Q: ${event.question}\nA: ${event.answer}`;
    default:
      return 'update';
  }
}

function renderDiscord(event: ReporterEvent): string {
  return `${headline(event)}\n${bodyLine(event)}`;
}

function renderGitHub(event: ReporterEvent): string {
  return `${STATUS_MARKER(event.task.id)}\n${headline(event)}\n${bodyLine(event)}`;
}
