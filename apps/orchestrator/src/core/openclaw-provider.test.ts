import { describe, expect, it } from 'vitest';

import type { AgentResumeRequest, AgentRunRequest, AgentRunResult, ProviderHealth } from './agent-runner';
import type {
  OpenClawExecutionRequest,
  OpenClawHealthRequest,
  OpenClawIpcClient,
  OpenClawResumeRequest,
  OpenClawRunResponse,
} from './openclaw-provider';
import { OpenClawProvider } from './openclaw-provider';
import type { ResolvedAgent } from './agent-registry';

class FakeOpenClawIpcClient implements OpenClawIpcClient {
  healthRequests: OpenClawHealthRequest[] = [];
  runRequests: OpenClawExecutionRequest[] = [];
  resumeRequests: OpenClawResumeRequest[] = [];

  healthResponse: ProviderHealth = { ok: true, message: 'ready' };
  runResponse: OpenClawRunResponse = {
    exitCode: 0,
    durationMs: 1200,
    sessionId: 'openclaw-session-1',
    stdoutPath: '/workspace/.forgeroom/logs/01.stdout.log',
    stderrPath: '/workspace/.forgeroom/logs/01.stderr.log',
    output: { exists: true, bytes: 2048 },
  };

  health(request: OpenClawHealthRequest): Promise<ProviderHealth> {
    this.healthRequests.push(request);
    return Promise.resolve(this.healthResponse);
  }

  run(request: OpenClawExecutionRequest): Promise<OpenClawRunResponse> {
    this.runRequests.push(request);
    return Promise.resolve(this.runResponse);
  }

  resume(request: OpenClawResumeRequest): Promise<OpenClawRunResponse> {
    this.resumeRequests.push(request);
    return Promise.resolve({
      ...this.runResponse,
      durationMs: 600,
      sessionId: request.sessionId,
    });
  }
}

const agent: ResolvedAgent = {
  agentId: 'claude',
  provider: 'openclaw',
  runtime: 'claude-cli',
  model: 'anthropic/claude-opus-4-7',
  harness: 'implementation',
};

const runRequest: AgentRunRequest = {
  agentId: 'claude',
  promptPath: '/workspace/.forgeroom/prompts/01_plan.md',
  outputPath: '/workspace/.forgeroom/outputs/01_plan.md',
  stdoutPath: '/workspace/.forgeroom/logs/01.stdout.log',
  stderrPath: '/workspace/.forgeroom/logs/01.stderr.log',
  cwd: '/workspace',
  mode: 'headless',
  timeoutMs: 300_000,
};

function createProvider(client = new FakeOpenClawIpcClient()): {
  client: FakeOpenClawIpcClient;
  provider: OpenClawProvider;
} {
  return {
    client,
    provider: new OpenClawProvider({
      endpoint: 'http://127.0.0.1:4317',
      token: 'test-token',
      runtime: 'claude-cli',
      client,
    }),
  };
}

describe('OpenClawProvider', () => {
  it('checks configured endpoint, token, and runtime readiness through the injected IPC client', async () => {
    const { client, provider } = createProvider();

    await expect(provider.health()).resolves.toEqual({ ok: true, message: 'ready' });

    expect(client.healthRequests).toEqual([
      {
        endpoint: 'http://127.0.0.1:4317',
        token: 'test-token',
        runtime: 'claude-cli',
      },
    ]);
  });

  it.each([
    ['endpoint', { endpoint: '' }],
    ['token', { token: '   ' }],
    ['runtime', { runtime: '' }],
  ])('fails health before IPC when configured %s is missing', async (_field, override) => {
    const client = new FakeOpenClawIpcClient();
    const provider = new OpenClawProvider({
      endpoint: 'http://127.0.0.1:4317',
      token: 'test-token',
      runtime: 'claude-cli',
      client,
      ...override,
    });

    await expect(provider.health()).resolves.toMatchObject({ ok: false });
    expect(client.healthRequests).toEqual([]);
  });

  it('translates a ForgeRoom run request into the selected OpenClaw IPC execution shape', async () => {
    const { client, provider } = createProvider();

    const result = await provider.run(runRequest, agent);

    expect(client.runRequests).toEqual([
      {
        endpoint: 'http://127.0.0.1:4317',
        token: 'test-token',
        runtime: 'claude-cli',
        model: 'anthropic/claude-opus-4-7',
        cwd: '/workspace',
        mode: 'headless',
        promptInstruction:
          'Read /workspace/.forgeroom/prompts/01_plan.md. Follow the instructions inside.',
        outputInstruction: 'Write your response to /workspace/.forgeroom/outputs/01_plan.md.',
        stdoutPath: '/workspace/.forgeroom/logs/01.stdout.log',
        stderrPath: '/workspace/.forgeroom/logs/01.stderr.log',
        timeoutMs: 300_000,
      },
    ]);
    expect(result).toEqual<AgentRunResult>({
      exitCode: 0,
      outputExists: true,
      outputBytes: 2048,
      durationMs: 1200,
      sessionId: 'openclaw-session-1',
      stdoutPath: '/workspace/.forgeroom/logs/01.stdout.log',
      stderrPath: '/workspace/.forgeroom/logs/01.stderr.log',
    });
  });

  it('translates resume using the explicit persisted execution context and addendum prompt path', async () => {
    const { client, provider } = createProvider();
    const resumeRequest: AgentResumeRequest = {
      sessionId: 'openclaw-session-1',
      addendumPromptPath: '/workspace/.forgeroom/prompts/01_retry.md',
      outputPath: '/workspace/.forgeroom/outputs/01_plan.md',
      stdoutPath: '/workspace/.forgeroom/logs/01.stdout.log',
      stderrPath: '/workspace/.forgeroom/logs/01.stderr.log',
      cwd: '/workspace',
      mode: 'headless',
      timeoutMs: 300_000,
    };

    const result = await provider.resume(resumeRequest, agent);

    expect(client.resumeRequests).toEqual([
      {
        endpoint: 'http://127.0.0.1:4317',
        token: 'test-token',
        sessionId: 'openclaw-session-1',
        runtime: 'claude-cli',
        model: 'anthropic/claude-opus-4-7',
        cwd: '/workspace',
        mode: 'headless',
        promptInstruction:
          'Read /workspace/.forgeroom/prompts/01_retry.md. Follow the instructions inside.',
        outputInstruction: 'Write your response to /workspace/.forgeroom/outputs/01_plan.md.',
        stdoutPath: '/workspace/.forgeroom/logs/01.stdout.log',
        stderrPath: '/workspace/.forgeroom/logs/01.stderr.log',
        timeoutMs: 300_000,
      },
    ]);
    expect(result.sessionId).toBe('openclaw-session-1');
    expect(result.failureKind).toBeUndefined();
  });

  it('maps IPC failure responses to common AgentRunResult failure kinds without raw diagnostics', async () => {
    const client = new FakeOpenClawIpcClient();
    client.runResponse = {
      ...client.runResponse,
      exitCode: 1,
      failureKind: 'agent_error',
      rawDiagnostics: { providerCode: 'OPENCLAW_RUNTIME_EXITED', detail: 'provider-local detail' },
      output: { exists: false, bytes: 0 },
    };
    const provider = createProvider(client).provider;

    const result = await provider.run(runRequest, agent);

    expect(result).toEqual<AgentRunResult>({
      exitCode: 1,
      failureKind: 'agent_error',
      outputExists: false,
      outputBytes: 0,
      durationMs: 1200,
      sessionId: 'openclaw-session-1',
      stdoutPath: '/workspace/.forgeroom/logs/01.stdout.log',
      stderrPath: '/workspace/.forgeroom/logs/01.stderr.log',
    });
    expect(result).not.toHaveProperty('rawDiagnostics');
  });
});
