import type { OrchestratorFailureCode } from './errors';
import type { ResolvedAgent } from './agent-registry';

export type AgentRunFailureKind = Extract<
  OrchestratorFailureCode,
  'runtime_unavailable' | 'auth_failed' | 'timeout' | 'agent_error' | 'output_contract_failed'
>;

export interface AgentRunRequest {
  agentId: string;
  promptPath: string;
  outputPath: string;
  stdoutPath: string;
  stderrPath: string;
  cwd: string;
  mode: 'headless' | 'pty';
  timeoutMs?: number;
}

export type AgentResumeRequest = Omit<AgentRunRequest, 'agentId' | 'promptPath'> & {
  sessionId: string;
  addendumPromptPath: string;
};

export interface AgentRunResult {
  exitCode: number;
  failureKind?: AgentRunFailureKind;
  outputExists: boolean;
  outputBytes: number;
  durationMs: number;
  sessionId: string | null;
  stdoutPath: string;
  stderrPath: string;
}

export interface ProviderHealth {
  ok: boolean;
  message: string;
}

export interface AgentRuntimeProvider {
  run(req: AgentRunRequest, agent: ResolvedAgent): Promise<AgentRunResult>;
  resume(req: AgentResumeRequest, agent: ResolvedAgent): Promise<AgentRunResult>;
  health(): Promise<ProviderHealth>;
}
