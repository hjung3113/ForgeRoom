export const ORCHESTRATOR_FAILURE_CODES = [
  'runtime_unavailable',
  'auth_failed',
  'timeout',
  'agent_error',
  'output_contract_failed',
  'check_failed_after_fix',
  'review_loop_max_iterations',
  'git_conflict',
  'pr_create_failed',
] as const;

export type OrchestratorFailureCode = (typeof ORCHESTRATOR_FAILURE_CODES)[number];

export function isOrchestratorFailureCode(value: string): value is OrchestratorFailureCode {
  return ORCHESTRATOR_FAILURE_CODES.includes(value as OrchestratorFailureCode);
}

export class OrchestratorError extends Error {
  readonly code: OrchestratorFailureCode;

  constructor(code: OrchestratorFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OrchestratorError';
    this.code = code;
  }
}

export class AgentError extends OrchestratorError {
  constructor(code: OrchestratorFailureCode, message: string, options?: ErrorOptions) {
    super(code, message, options);
    this.name = 'AgentError';
  }
}

export class WorkflowError extends OrchestratorError {
  constructor(code: OrchestratorFailureCode, message: string, options?: ErrorOptions) {
    super(code, message, options);
    this.name = 'WorkflowError';
  }
}

export class CheckFailedError extends OrchestratorError {
  constructor(code: Extract<OrchestratorFailureCode, 'check_failed_after_fix'>, message: string) {
    super(code, message);
    this.name = 'CheckFailedError';
  }
}

export class PathSafetyError extends OrchestratorError {
  constructor(message: string, options?: ErrorOptions) {
    super('git_conflict', message, options);
    this.name = 'PathSafetyError';
  }
}
