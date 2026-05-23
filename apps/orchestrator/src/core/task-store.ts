import type {
  Check,
  ConductorState,
  Event,
  EventDelivery,
  ExternalRef,
  Step,
  Task,
  TaskStatus,
} from './types.js';
import type { OrchestratorFailureCode } from './errors.js';

export type CreateTaskInput = Omit<
  Task,
  'created_at' | 'updated_at' | 'failure_reason' | 'mastra_run_id'
> & {
  failure_reason?: OrchestratorFailureCode | null;
  external_ref: ExternalRef | null;
  // ADR-017: optional at creation. New tasks have no Mastra run yet, so this
  // defaults to null; the value is set later via setMastraRunId.
  mastra_run_id?: string | null;
};

export type CreateStepInput = Step;

export type CreateCheckInput = Omit<Check, 'created_at'> & {
  created_at?: Date;
};

export type CreateEventInput = Event;

export type CreateEventDeliveryInput = Omit<
  EventDelivery,
  'delivery_attempts' | 'next_delivery_at' | 'last_delivery_error' | 'delivered_at' | 'created_at'
> & {
  delivery_attempts?: number;
  next_delivery_at?: Date | null;
  last_delivery_error?: string | null;
  delivered_at?: Date | null;
  created_at?: Date;
};

export interface MarkDeliveryFailedPatch {
  delivery_attempts: number;
  next_delivery_at: Date | null;
  last_delivery_error: string | null;
}

export interface TaskStore {
  createTask(input: CreateTaskInput): Promise<Task>;
  startTask(input: CreateTaskInput): Promise<Task>;
  updateTaskStatus(
    id: string,
    status: TaskStatus,
    failureReason?: OrchestratorFailureCode | null,
  ): Promise<void>;
  getTask(id: string): Promise<Task | null>;
  listActiveTasks(projectId?: string): Promise<Task[]>;
  // ADR-017: recoverPending() reads/writes the Mastra run pointer to pick
  // resume vs. fresh-run. Read path is normally getTask(); these accessors give
  // recoverPending a focused write/read without round-tripping the whole row.
  getMastraRunId(taskId: string): Promise<string | null>;
  setMastraRunId(taskId: string, mastraRunId: string | null): Promise<void>;
  updateTaskFinalSlices(id: string, finalSlices: string[]): Promise<void>;
  /**
   * Persist the PR number resolved by the PR external effect (ADR-019). Set
   * once an open PR is created or discovered so a recoverPending() replay reuses
   * it instead of creating a duplicate.
   */
  setPrNumber(id: string, prNumber: number): Promise<void>;
  /**
   * Persist the per-task status-surface ids (ADR-013) back onto
   * `tasks.external_ref`. The Reporter mints the surface id on first delivery
   * and re-uses it so re-delivery edits the same Discord message / GitHub
   * comment instead of creating a duplicate. The composition root adapts the
   * full TaskStore to the narrow {@link ReporterStore} via this method.
   */
  setExternalRef(id: string, externalRef: ExternalRef | null): Promise<void>;
  acquireProjectLock(projectId: string, taskId: string): Promise<boolean>;
  releaseProjectLock(projectId: string, taskId: string): Promise<void>;
  createStep(input: CreateStepInput): Promise<Step>;
  updateStep(id: string, patch: Partial<Step>): Promise<void>;
  completeStepWithEvent(
    stepId: string,
    patch: Partial<Step>,
    event: CreateEventInput,
  ): Promise<{ step: Step; event: Event }>;
  listSteps(taskId: string): Promise<Step[]>;
  recordCheck(input: CreateCheckInput): Promise<Check>;
  enqueueEvent(input: CreateEventInput): Promise<Event>;
  getEvent(id: string): Promise<Event | null>;
  markUserFeedbackApplied(eventId: string, appliedAt: Date): Promise<void>;
  upsertConductorState(
    taskId: string,
    summary: string,
    summaryPath: string,
    lastStepId?: string | null,
  ): Promise<void>;
  getConductorState(taskId: string): Promise<ConductorState | null>;
  cancelTask(taskId: string, eventId: string, payload?: Record<string, unknown>): Promise<void>;
  enqueueEventDelivery(input: CreateEventDeliveryInput): Promise<EventDelivery>;
  markDeliveryDelivered(id: string): Promise<void>;
  markDeliveryFailed(id: string, patch: MarkDeliveryFailedPatch): Promise<void>;
  listDueUndeliveredDeliveries(now: Date): Promise<EventDelivery[]>;
}
