import type { SourceLocation, WorkflowExpressionErrorCode } from './types';

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
