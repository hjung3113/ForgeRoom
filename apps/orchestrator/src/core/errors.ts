export type OrchestratorFailureCode =
  | 'runtime_unavailable'
  | 'auth_failed'
  | 'timeout'
  | 'agent_error'
  | 'output_contract_failed'
  | 'check_failed_after_fix'
  | 'review_loop_max_iterations'
  | 'git_conflict'
  | 'pr_create_failed'
  | 'path_safety_violation'
  | 'workflow_error';

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
    super('path_safety_violation', message, options);
    this.name = 'PathSafetyError';
  }
}
