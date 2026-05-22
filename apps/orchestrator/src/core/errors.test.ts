import { describe, expect, it } from 'vitest';

import {
  AgentError,
  CheckFailedError,
  OrchestratorError,
  PathSafetyError,
  WorkflowError,
} from './errors';

describe('OrchestratorError', () => {
  it('keeps a stable code and cause for reporter-safe failures', () => {
    const cause = new Error('raw provider failure');
    const error = new AgentError('agent_error', 'Agent failed to produce output', { cause });

    expect(error).toBeInstanceOf(OrchestratorError);
    expect(error.name).toBe('AgentError');
    expect(error.code).toBe('agent_error');
    expect(error.message).toBe('Agent failed to produce output');
    expect(error.cause).toBe(cause);
  });

  it('exposes workflow and check failures as typed orchestrator errors', () => {
    const workflowError = new WorkflowError('output_contract_failed', 'Missing Review Result');
    const checkError = new CheckFailedError('check_failed_after_fix', 'Tests failed after retry');

    expect(workflowError).toBeInstanceOf(OrchestratorError);
    expect(checkError).toBeInstanceOf(OrchestratorError);
    expect(workflowError.code).toBe('output_contract_failed');
    expect(checkError.code).toBe('check_failed_after_fix');
  });

  it('exposes unsafe paths as typed orchestrator errors', () => {
    const error = new PathSafetyError('Path is outside allowed root');

    expect(error).toBeInstanceOf(OrchestratorError);
    expect(error.name).toBe('PathSafetyError');
    expect(error.code).toBe('path_safety_violation');
  });
});
