/**
 * OrchestratorGatewayPort implementation (#30).
 *
 * The DiscordGateway (#27) dispatches its seven slash commands to the injected
 * {@link OrchestratorGatewayPort} facade. This composition-root implementation
 * maps each intent onto the real collaborators:
 *   /run      → PipelineEngine.runFull(projectId, TaskInput, RunOpts)
 *   /pause    → PipelineEngine.pause
 *   /resume   → PipelineEngine.resume
 *   /cancel   → PipelineEngine.cancel
 *   /status   → TaskStore.getTask / listActiveTasks
 *   /ask      → Conductor.answer
 *   /feedback → Conductor.integrateFeedback (after recording the message)
 *   approval  → TaskStore event (dirty-baseline approval, ADR-013)
 *
 * The GitHub issue source emits the same {@link TaskRequest}; the composition
 * root routes it through {@link startTask} too, so both TaskSources share one
 * admission path (ApprovalGate runs inside runFull).
 */
import type { PipelineEngine, TaskInput } from '../core/engine/pipeline-engine.js';
import type { Conductor, Task, TaskRequest } from '../core/types.js';
import type { TaskStore } from '../core/task-store.js';
import type { OrchestratorGatewayPort } from '../gateway/discord-gateway.js';

export interface OrchestratorGatewayPortDeps {
  engine: PipelineEngine;
  conductor: Conductor;
  taskStore: TaskStore;
  /** Records dirty-baseline approval as a task event (ADR-013). */
  recordApprovalEvent: (taskId: string, approvedBy: string) => Promise<void>;
  /** Records user feedback for the next step's Conductor.refine input. */
  recordFeedbackEvent: (taskId: string, message: string) => Promise<void>;
}

export class OrchestratorGatewayPortImpl implements OrchestratorGatewayPort {
  private readonly engine: PipelineEngine;
  private readonly conductor: Conductor;
  private readonly taskStore: TaskStore;
  private readonly recordApprovalEvent: (taskId: string, approvedBy: string) => Promise<void>;
  private readonly recordFeedbackEvent: (taskId: string, message: string) => Promise<void>;

  constructor(deps: OrchestratorGatewayPortDeps) {
    this.engine = deps.engine;
    this.conductor = deps.conductor;
    this.taskStore = deps.taskStore;
    this.recordApprovalEvent = deps.recordApprovalEvent;
    this.recordFeedbackEvent = deps.recordFeedbackEvent;
  }

  startTask(request: TaskRequest): Promise<string> {
    const input: TaskInput = {
      title: request.title,
      description: request.description,
      source: request.source,
      externalRef: request.externalRef ?? null,
      issueNumber: request.issueNumber ?? null,
    };
    return this.engine.runFull(request.projectId, input, {
      ...(request.workflowId === undefined ? {} : { workflowId: request.workflowId }),
      ...(request.vars === undefined ? {} : { vars: request.vars }),
    });
  }

  pauseTask(taskId: string): Promise<void> {
    return this.engine.pause(taskId);
  }

  resumeTask(taskId: string): Promise<void> {
    return this.engine.resume(taskId);
  }

  cancelTask(taskId: string): Promise<void> {
    return this.engine.cancel(taskId);
  }

  getTaskStatus(taskId: string): Promise<Task | null> {
    return this.taskStore.getTask(taskId);
  }

  listActiveTasks(projectId?: string): Promise<Task[]> {
    return this.taskStore.listActiveTasks(projectId);
  }

  askTask(taskId: string, question: string): Promise<string> {
    return this.conductor.answer(taskId, question);
  }

  async recordFeedback(taskId: string, message: string): Promise<void> {
    // Record the feedback, then fold it into feedback.md so the next step's
    // Conductor.refine picks it up (conductor.md Pending→Applied flow).
    await this.recordFeedbackEvent(taskId, message);
    await this.conductor.integrateFeedback(taskId);
  }

  recordApproval(taskId: string, approvedBy: string): Promise<void> {
    return this.recordApprovalEvent(taskId, approvedBy);
  }
}
