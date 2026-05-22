import type {
  AgentRunFailureKind,
  AgentRunRequest,
  AgentRunResult,
  AgentResumeRequest,
  AgentRuntimeProvider,
  ProviderHealth,
} from './agent-runner';
import type { ResolvedAgent } from './agent-registry';

export interface OpenClawHealthRequest {
  endpoint: string;
  token: string;
  runtime: string;
}

export interface OpenClawExecutionRequest {
  endpoint: string;
  token: string;
  runtime: string;
  model: string;
  cwd: string;
  mode: 'headless' | 'pty';
  promptInstruction: string;
  outputInstruction: string;
  stdoutPath: string;
  stderrPath: string;
  timeoutMs?: number;
}

export interface OpenClawResumeRequest extends OpenClawExecutionRequest {
  sessionId: string;
}

export interface OpenClawRunResponse {
  exitCode: number;
  failureKind?: AgentRunFailureKind;
  output: {
    exists: boolean;
    bytes: number;
  };
  durationMs: number;
  sessionId: string | null;
  stdoutPath: string;
  stderrPath: string;
  rawDiagnostics?: Record<string, unknown>;
}

export interface OpenClawIpcClient {
  health(request: OpenClawHealthRequest): Promise<ProviderHealth>;
  run(request: OpenClawExecutionRequest): Promise<OpenClawRunResponse>;
  resume(request: OpenClawResumeRequest): Promise<OpenClawRunResponse>;
}

export interface OpenClawProviderConfig {
  endpoint: string;
  token: string;
  runtime: string;
  client: OpenClawIpcClient;
}

export class OpenClawProvider implements AgentRuntimeProvider {
  constructor(private readonly config: OpenClawProviderConfig) {}

  async health(): Promise<ProviderHealth> {
    const missingField = this.missingConfiguredField();
    if (missingField) {
      return { ok: false, message: `OpenClaw ${missingField} is required` };
    }

    return this.config.client.health({
      endpoint: this.config.endpoint,
      token: this.config.token,
      runtime: this.config.runtime,
    });
  }

  async run(req: AgentRunRequest, agent: ResolvedAgent): Promise<AgentRunResult> {
    const response = await this.config.client.run({
      endpoint: this.config.endpoint,
      token: this.config.token,
      runtime: agent.runtime,
      model: agent.model,
      cwd: req.cwd,
      mode: req.mode,
      promptInstruction: promptInstruction(req.promptPath),
      outputInstruction: outputInstruction(req.outputPath),
      stdoutPath: req.stdoutPath,
      stderrPath: req.stderrPath,
      ...(req.timeoutMs === undefined ? {} : { timeoutMs: req.timeoutMs }),
    });

    return mapRunResponse(response);
  }

  async resume(req: AgentResumeRequest, agent: ResolvedAgent): Promise<AgentRunResult> {
    const response = await this.config.client.resume({
      endpoint: this.config.endpoint,
      token: this.config.token,
      sessionId: req.sessionId,
      runtime: agent.runtime,
      model: agent.model,
      cwd: req.cwd,
      mode: req.mode,
      promptInstruction: promptInstruction(req.addendumPromptPath),
      outputInstruction: outputInstruction(req.outputPath),
      stdoutPath: req.stdoutPath,
      stderrPath: req.stderrPath,
      ...(req.timeoutMs === undefined ? {} : { timeoutMs: req.timeoutMs }),
    });

    return mapRunResponse(response);
  }

  private missingConfiguredField(): 'endpoint' | 'token' | 'runtime' | null {
    if (this.config.endpoint.trim() === '') {
      return 'endpoint';
    }
    if (this.config.token.trim() === '') {
      return 'token';
    }
    if (this.config.runtime.trim() === '') {
      return 'runtime';
    }

    return null;
  }
}

function promptInstruction(promptPath: string): string {
  return `Read ${promptPath}. Follow the instructions inside.`;
}

function outputInstruction(outputPath: string): string {
  return `Write your response to ${outputPath}.`;
}

function mapRunResponse(response: OpenClawRunResponse): AgentRunResult {
  return {
    exitCode: response.exitCode,
    ...(response.failureKind === undefined ? {} : { failureKind: response.failureKind }),
    outputExists: response.output.exists,
    outputBytes: response.output.bytes,
    durationMs: response.durationMs,
    sessionId: response.sessionId,
    stdoutPath: response.stdoutPath,
    stderrPath: response.stderrPath,
  };
}
