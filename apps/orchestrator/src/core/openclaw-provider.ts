import type {
  AgentRunFailureKind,
  AgentRunRequest,
  AgentRunResult,
  AgentResumeRequest,
  AgentRuntimeProvider,
  ProviderHealth,
} from './agent-runner.js';
import type { ResolvedAgent } from './agent-registry.js';

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
  /** OpenClaw agent id to drive (`openclaw agent --agent <id>`). */
  agentId: string;
  cwd: string;
  mode: 'headless' | 'pty';
  /**
   * ForgeRoom prompt file (`.forgeroom/prompts/NN_*.md`). The adapter reads its
   * content and passes it inline as `--message` (the real CLI takes the prompt
   * inline, not as a file path). The file is kept for audit.
   */
  promptPath: string;
  /**
   * ForgeRoom output file (`.forgeroom/outputs/NN_*.md`). The adapter parses the
   * agent's JSON reply and WRITES it here (the agent no longer writes the file).
   */
  outputPath: string;
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
  /** OpenClaw agent id every run drives (FORGEROOM_OPENCLAW_AGENT, default `main`). */
  agentId: string;
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
      agentId: this.config.agentId,
      cwd: req.cwd,
      mode: req.mode,
      promptPath: req.promptPath,
      outputPath: req.outputPath,
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
      agentId: this.config.agentId,
      cwd: req.cwd,
      mode: req.mode,
      promptPath: req.addendumPromptPath,
      outputPath: req.outputPath,
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
