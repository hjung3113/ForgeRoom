import type { SourceLocation, WorkflowExpressionErrorCode } from './types.js';

export class WorkflowParseError extends Error {
  constructor(
    message: string,
    readonly location: SourceLocation | null = null,
    readonly source = '<workflow-yaml>',
  ) {
    super(formatMessage(message, location));
    this.name = 'WorkflowParseError';
  }
}

/**
 * Raised when the yaml DSL -> Mastra adapter rejects a parsed workflow during
 * its validate phase (ADR-016: WorkflowRegistry.load -> workflow-parser ->
 * adapter.validate -> Mastra build). The `failure_reason` string is the value
 * the PipelineEngine records on the task; it intentionally lives here rather
 * than in core's OrchestratorFailureCode union because adapter validation is a
 * startup-time (build) failure, not a task runtime failure.
 */
export class AdapterValidationError extends Error {
  readonly failure_reason = 'adapter_validation_failed' as const;

  constructor(
    message: string,
    readonly workflowId: string,
    readonly field: string | null = null,
  ) {
    super(field === null ? message : `${message} (${workflowId}.${field})`);
    this.name = 'AdapterValidationError';
  }
}

export class WorkflowExpressionError extends Error {
  constructor(
    message: string,
    readonly code: WorkflowExpressionErrorCode,
    readonly expression: string,
  ) {
    super(`${message}: ${expression}`);
    this.name = 'WorkflowExpressionError';
  }
}

function formatMessage(message: string, location: SourceLocation | null): string {
  if (location === null) {
    return message;
  }

  return `${message} at line ${String(location.line)}, column ${String(location.column)}`;
}
