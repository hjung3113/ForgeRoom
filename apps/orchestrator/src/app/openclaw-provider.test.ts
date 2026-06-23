import { describe, expect, it } from 'vitest';

import type {
  AgentResumeRequest,
  AgentRunRequest,
  AgentRunResult,
  ProviderHealth,
} from '../core/agent-runtime/agent-runner.js';
import type {
  OpenClawExecutionRequest,
  OpenClawHealthRequest,
  OpenClawIpcClient,
  OpenClawResumeRequest,
  OpenClawRunResponse,
} from './openclaw-provider.js';
import { OpenClawProvider } from './openclaw-provider.js';
import type { ResolvedAgent } from '../core/agent-runtime/agent-registry.js';

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

  addAgent(): Promise<void> {
    return Promise.resolve();
  }

  deleteAgent(): Promise<void> {
    return Promise.resolve();
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
      endpoint: 'http://127.0.0.1:18789',
      token: 'test-token',
      runtime: 'claude-cli',
      agentId: 'main',
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
        endpoint: 'http://127.0.0.1:18789',
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
      endpoint: 'http://127.0.0.1:18789',
      token: 'test-token',
      runtime: 'claude-cli',
      agentId: 'main',
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
        endpoint: 'http://127.0.0.1:18789',
        token: 'test-token',
        runtime: 'claude-cli',
        model: 'anthropic/claude-opus-4-7',
        agentId: 'main',
        cwd: '/workspace',
        mode: 'headless',
        promptPath: '/workspace/.forgeroom/prompts/01_plan.md',
        outputPath: '/workspace/.forgeroom/outputs/01_plan.md',
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

  it('prefers runtimeSession.providerAgentId over the global config agent on run (ADR-028)', async () => {
    const { client, provider } = createProvider();

    await provider.run({ ...runRequest, runtimeSession: { providerAgentId: 'fr-impl', role: 'implementer' } }, agent);

    expect(client.runRequests[0]!.agentId).toBe('fr-impl');
  });

  it('falls back to the global config agent when runtimeSession is absent', async () => {
    const { client, provider } = createProvider();

    await provider.run(runRequest, agent);

    expect(client.runRequests[0]!.agentId).toBe('main');
  });

  it('prefers runtimeSession.providerAgentId on resume too (overridden-agent continuity)', async () => {
    const { client, provider } = createProvider();

    await provider.resume(
      {
        sessionId: 'openclaw-session-1',
        addendumPromptPath: '/workspace/.forgeroom/prompts/01_retry.md',
        outputPath: '/workspace/.forgeroom/outputs/01_plan.md',
        stdoutPath: '/workspace/.forgeroom/logs/01.stdout.log',
        stderrPath: '/workspace/.forgeroom/logs/01.stderr.log',
        cwd: '/workspace',
        mode: 'headless',
        timeoutMs: 300_000,
        runtimeSession: { providerAgentId: 'fr-impl', role: 'implementer' },
      },
      agent,
    );

    expect(client.resumeRequests[0]!.agentId).toBe('fr-impl');
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
        endpoint: 'http://127.0.0.1:18789',
        token: 'test-token',
        sessionId: 'openclaw-session-1',
        runtime: 'claude-cli',
        model: 'anthropic/claude-opus-4-7',
        agentId: 'main',
        cwd: '/workspace',
        mode: 'headless',
        promptPath: '/workspace/.forgeroom/prompts/01_retry.md',
        outputPath: '/workspace/.forgeroom/outputs/01_plan.md',
        stdoutPath: '/workspace/.forgeroom/logs/01.stdout.log',
        stderrPath: '/workspace/.forgeroom/logs/01.stderr.log',
        timeoutMs: 300_000,
      },
    ]);
    expect(result.sessionId).toBe('openclaw-session-1');
    expect(result.failureKind).toBeUndefined();
  });

  it('prefers req.runtimeTarget runtime/model over the resolved agent (ADR-023)', async () => {
    const { client, provider } = createProvider();

    await provider.run(
      {
        ...runRequest,
        runtimeTarget: { providerId: 'openclaw', runtime: 'codex-cli', model: 'openai/gpt-5.5' },
      },
      agent,
    );

    expect(client.runRequests[0]).toMatchObject({ runtime: 'codex-cli', model: 'openai/gpt-5.5' });
  });

  it('falls back to the resolved agent runtime/model when no runtimeTarget is present', async () => {
    const { client, provider } = createProvider();

    await provider.run(runRequest, agent);

    expect(client.runRequests[0]).toMatchObject({
      runtime: 'claude-cli',
      model: 'anthropic/claude-opus-4-7',
    });
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
