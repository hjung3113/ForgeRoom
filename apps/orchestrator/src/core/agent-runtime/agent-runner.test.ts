import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { AgentRegistry, type ResolvedAgent } from './agent-registry.js';
import {
  DEFAULT_AGENT_TIMEOUT_MS,
  DefaultAgentRunner,
  type AgentResumeRequest,
  type AgentRunnerResumeRequest,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRuntimeProvider,
  type ProviderHealth,
  type ResolvedRuntimeTarget,
} from './agent-runner.js';
import { HarnessRegistry } from './harness-registry.js';

class FakeAgentRuntimeProvider implements AgentRuntimeProvider {
  // The injected `runtimeTarget` (ADR-023) is captured separately so the
  // request-shape assertions below stay focused on timeout/session/retry
  // behavior; target injection is asserted by its own dedicated test.
  runRequests: Array<{ req: AgentRunRequest; agent: ResolvedAgent }> = [];
  resumeRequests: Array<{ req: AgentResumeRequest; agent: ResolvedAgent }> = [];
  runTargets: Array<ResolvedRuntimeTarget | undefined> = [];
  resumeTargets: Array<ResolvedRuntimeTarget | undefined> = [];
  results: AgentRunResult[] = [];

  health(): Promise<ProviderHealth> {
    return Promise.resolve({ ok: true, message: 'ready' });
  }

  run(req: AgentRunRequest, agent: ResolvedAgent): Promise<AgentRunResult> {
    const { runtimeTarget, ...rest } = req;
    this.runTargets.push(runtimeTarget);
    this.runRequests.push({ req: rest, agent });
    return Promise.resolve(this.nextResult(req));
  }

  resume(req: AgentResumeRequest, agent: ResolvedAgent): Promise<AgentRunResult> {
    const { runtimeTarget, ...rest } = req;
    this.resumeTargets.push(runtimeTarget);
    this.resumeRequests.push({ req: rest, agent });
    return Promise.resolve(this.nextResult(req));
  }

  private nextResult(req: Pick<AgentRunRequest, 'stdoutPath' | 'stderrPath'>): AgentRunResult {
    const result = this.results.shift();
    if (!result) {
      throw new Error('missing fake provider result');
    }

    return {
      ...result,
      stdoutPath: req.stdoutPath,
      stderrPath: req.stderrPath,
    };
  }
}

const harnesses = HarnessRegistry.fromConfig({
  implementation: { source: '.forgeroom/harnesses/implementation' },
});

const registry = AgentRegistry.fromConfig(
  {
    claude: {
      provider: 'openclaw',
      runtime: 'claude-cli',
      model: 'anthropic/claude-opus-4-7',
      harness: 'implementation',
    },
  },
  harnesses,
);

const resolvedAgent: ResolvedAgent = {
  agentId: 'claude',
  provider: 'openclaw',
  runtime: 'claude-cli',
  model: 'anthropic/claude-opus-4-7',
  harness: 'implementation',
};

function providerResult(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    exitCode: 0,
    outputExists: true,
    outputBytes: 256,
    durationMs: 100,
    sessionId: 'session-1',
    stdoutPath: '',
    stderrPath: '',
    ...overrides,
  };
}

describe('DefaultAgentRunner', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function createRunRequest(): Promise<AgentRunRequest> {
    const cwd = await mkdtemp(join(tmpdir(), 'forgeroom-agent-runner-'));
    tempDirs.push(cwd);
    const promptPath = join(cwd, '.forgeroom', 'prompts', '01_plan.md');
    const outputPath = join(cwd, '.forgeroom', 'outputs', '01_plan.md');
    const stdoutPath = join(cwd, '.forgeroom', 'logs', '01_plan.stdout');
    const stderrPath = join(cwd, '.forgeroom', 'logs', '01_plan.stderr');

    return {
      agentId: 'claude',
      promptPath,
      outputPath,
      stdoutPath,
      stderrPath,
      cwd,
      mode: 'headless',
      timeoutMs: 300_000,
    };
  }

  async function writeOutput(filePath: string, content: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }

  it('resolves the requested agent, delegates the first attempt to provider.run, and trusts a valid output file', async () => {
    const req = await createRunRequest();
    await writeOutput(req.outputPath, 'x'.repeat(50));
    const provider = new FakeAgentRuntimeProvider();
    provider.results = [providerResult({ outputExists: false, outputBytes: 0 })];
    const runner = new DefaultAgentRunner({ agentRegistry: registry, provider });

    const result = await runner.run(req);

    expect(provider.runRequests).toEqual([{ req, agent: resolvedAgent }]);
    expect(provider.resumeRequests).toEqual([]);
    expect(result).toMatchObject({
      outputExists: true,
      outputBytes: 50,
    });
    expect(result.failureKind).toBeUndefined();
  });

  it('derives a provider-neutral runtimeTarget from the resolved agent (ADR-023)', async () => {
    const req = await createRunRequest();
    await writeOutput(req.outputPath, 'x'.repeat(50));
    const provider = new FakeAgentRuntimeProvider();
    provider.results = [providerResult({ outputExists: false, outputBytes: 0 })];
    const runner = new DefaultAgentRunner({ agentRegistry: registry, provider });

    await runner.run(req);

    expect(provider.runTargets[0]).toEqual<ResolvedRuntimeTarget>({
      providerId: 'openclaw',
      runtime: 'claude-cli',
      model: 'anthropic/claude-opus-4-7',
    });
  });

  it('applies the configured default timeout when a run request omits timeoutMs', async () => {
    const { timeoutMs: _timeoutMs, ...req } = await createRunRequest();
    await writeOutput(req.outputPath, 'x'.repeat(50));
    const provider = new FakeAgentRuntimeProvider();
    provider.results = [providerResult()];
    const runner = new DefaultAgentRunner({
      agentRegistry: registry,
      provider,
      defaultTimeoutMs: 123_000,
    });

    await runner.run(req);

    expect(provider.runRequests).toEqual([
      {
        req: { ...req, timeoutMs: 123_000 },
        agent: resolvedAgent,
      },
    ]);
  });

  it('preserves an explicit per-request timeout over the runner default', async () => {
    const req = {
      ...(await createRunRequest()),
      timeoutMs: 42_000,
    };
    await writeOutput(req.outputPath, 'x'.repeat(50));
    const provider = new FakeAgentRuntimeProvider();
    provider.results = [providerResult()];
    const runner = new DefaultAgentRunner({
      agentRegistry: registry,
      provider,
      defaultTimeoutMs: 123_000,
    });

    await runner.run(req);

    expect(provider.runRequests).toEqual([
      {
        req: { ...req, timeoutMs: 42_000 },
        agent: resolvedAgent,
      },
    ]);
  });

  it('retries a tiny output by resuming the provider session with an injected addendum prompt path', async () => {
    const req = await createRunRequest();
    await writeOutput(req.outputPath, 'too small');
    const retryPromptPath = join(req.cwd, '.forgeroom', 'prompts', '01_plan.retry-2.md');
    const provider = new FakeAgentRuntimeProvider();
    provider.results = [providerResult(), providerResult({ durationMs: 75 })];
    const runner = new DefaultAgentRunner({
      agentRegistry: registry,
      provider,
      createRetryPrompt: async () => {
        await writeFile(req.outputPath, 'x'.repeat(51));
        return retryPromptPath;
      },
    });

    const result = await runner.run(req);

    expect(provider.runRequests).toHaveLength(1);
    expect(provider.resumeRequests).toEqual([
      {
        req: {
          sessionId: 'session-1',
          addendumPromptPath: retryPromptPath,
          outputPath: req.outputPath,
          stdoutPath: req.stdoutPath,
          stderrPath: req.stderrPath,
          cwd: req.cwd,
          mode: req.mode,
          timeoutMs: req.timeoutMs,
        },
        agent: resolvedAgent,
      },
    ]);
    expect(result).toMatchObject({ outputExists: true, outputBytes: 51 });
    expect(result.failureKind).toBeUndefined();
  });

  it('carries runtimeSession into the resume retry (overridden agent must not fall back) (ADR-028)', async () => {
    const req = { ...(await createRunRequest()), runtimeSession: { providerAgentId: 'fr-impl', role: 'implementer' } };
    await writeOutput(req.outputPath, 'too small');
    const retryPromptPath = join(req.cwd, '.forgeroom', 'prompts', '01_plan.retry-2.md');
    const provider = new FakeAgentRuntimeProvider();
    provider.results = [providerResult(), providerResult({ durationMs: 75 })];
    const runner = new DefaultAgentRunner({
      agentRegistry: registry,
      provider,
      createRetryPrompt: async () => {
        await writeFile(req.outputPath, 'x'.repeat(51));
        return retryPromptPath;
      },
    });

    await runner.run(req);

    expect(provider.resumeRequests[0]!.req.runtimeSession).toEqual({
      providerAgentId: 'fr-impl',
      role: 'implementer',
    });
  });

  it('applies the built-in default timeout to internal resume retries when the run request omits timeoutMs', async () => {
    const { timeoutMs: _timeoutMs, ...req } = await createRunRequest();
    await writeOutput(req.outputPath, 'too small');
    const retryPromptPath = join(req.cwd, '.forgeroom', 'prompts', '01_plan.retry-2.md');
    const provider = new FakeAgentRuntimeProvider();
    provider.results = [providerResult(), providerResult({ durationMs: 75 })];
    const runner = new DefaultAgentRunner({
      agentRegistry: registry,
      provider,
      createRetryPrompt: async () => {
        await writeFile(req.outputPath, 'x'.repeat(51));
        return retryPromptPath;
      },
    });

    await runner.run(req);

    expect(provider.runRequests[0]?.req.timeoutMs).toBe(DEFAULT_AGENT_TIMEOUT_MS);
    expect(provider.resumeRequests).toEqual([
      {
        req: {
          sessionId: 'session-1',
          addendumPromptPath: retryPromptPath,
          outputPath: req.outputPath,
          stdoutPath: req.stdoutPath,
          stderrPath: req.stderrPath,
          cwd: req.cwd,
          mode: req.mode,
          timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
        },
        agent: resolvedAgent,
      },
    ]);
  });

  it('falls back to provider.run for output retries when the previous attempt has no session id', async () => {
    const req = await createRunRequest();
    const retryPromptPath = join(req.cwd, '.forgeroom', 'prompts', '01_plan.retry-2.md');
    const provider = new FakeAgentRuntimeProvider();
    provider.results = [providerResult({ sessionId: null }), providerResult({ sessionId: null })];
    const runner = new DefaultAgentRunner({
      agentRegistry: registry,
      provider,
      createRetryPrompt: async () => {
        await writeOutput(req.outputPath, 'x'.repeat(52));
        return retryPromptPath;
      },
    });

    const result = await runner.run(req);

    expect(provider.runRequests).toEqual([
      { req, agent: resolvedAgent },
      { req: { ...req, promptPath: retryPromptPath }, agent: resolvedAgent },
    ]);
    expect(provider.resumeRequests).toEqual([]);
    expect(result).toMatchObject({ outputExists: true, outputBytes: 52 });
    expect(result.failureKind).toBeUndefined();
  });

  it('returns output_contract_failed after the output-producing attempt budget is exhausted', async () => {
    const req = await createRunRequest();
    await writeOutput(req.outputPath, 'short');
    const provider = new FakeAgentRuntimeProvider();
    provider.results = [providerResult(), providerResult(), providerResult()];
    const runner = new DefaultAgentRunner({
      agentRegistry: registry,
      provider,
      minOutputBytes: 50,
      maxAttempts: 3,
      createRetryPrompt: () => Promise.resolve(join(req.cwd, '.forgeroom', 'prompts', 'retry.md')),
    });

    const result = await runner.run(req);

    expect(provider.runRequests).toHaveLength(1);
    expect(provider.resumeRequests).toHaveLength(2);
    expect(result).toMatchObject({
      failureKind: 'output_contract_failed',
      outputExists: true,
      outputBytes: 5,
    });
  });

  it('spends the output-producing attempt budget on retryable provider failures even when a stale output file exists', async () => {
    const req = await createRunRequest();
    await writeOutput(req.outputPath, 'stale output from previous attempt'.repeat(3));
    const retryPromptPath = join(req.cwd, '.forgeroom', 'prompts', '01_plan.retry-2.md');
    const provider = new FakeAgentRuntimeProvider();
    provider.results = [
      providerResult({
        exitCode: 1,
        failureKind: 'agent_error',
        outputExists: false,
        outputBytes: 0,
      }),
      providerResult(),
    ];
    const runner = new DefaultAgentRunner({
      agentRegistry: registry,
      provider,
      createRetryPrompt: async () => {
        await writeOutput(req.outputPath, 'x'.repeat(53));
        return retryPromptPath;
      },
    });

    const result = await runner.run(req);

    expect(provider.runRequests).toHaveLength(1);
    expect(provider.resumeRequests).toEqual([
      {
        req: {
          sessionId: 'session-1',
          addendumPromptPath: retryPromptPath,
          outputPath: req.outputPath,
          stdoutPath: req.stdoutPath,
          stderrPath: req.stderrPath,
          cwd: req.cwd,
          mode: req.mode,
          timeoutMs: req.timeoutMs,
        },
        agent: resolvedAgent,
      },
    ]);
    expect(result).toMatchObject({ exitCode: 0, outputExists: true, outputBytes: 53 });
    expect(result.failureKind).toBeUndefined();
  });

  it('lets PipelineEngine continue selector failures through the same resume budget', async () => {
    const req = await createRunRequest();
    const selectorRetry: AgentRunnerResumeRequest = {
      agentId: req.agentId,
      promptPath: req.promptPath,
      sessionId: 'session-1',
      addendumPromptPath: join(req.cwd, '.forgeroom', 'prompts', '01_plan.selector-retry.md'),
      outputPath: req.outputPath,
      stdoutPath: req.stdoutPath,
      stderrPath: req.stderrPath,
      cwd: req.cwd,
      mode: req.mode,
      attempt: 2,
      ...(req.timeoutMs === undefined ? {} : { timeoutMs: req.timeoutMs }),
    };
    const provider = new FakeAgentRuntimeProvider();
    provider.results = [providerResult({ durationMs: 80 })];
    const runner = new DefaultAgentRunner({
      agentRegistry: registry,
      provider,
      createRetryPrompt: () =>
        Promise.reject(new Error('selector retry should not need a second retry prompt')),
    });

    await writeOutput(req.outputPath, 'x'.repeat(54));
    const result = await runner.resume(selectorRetry);

    expect(provider.runRequests).toEqual([]);
    expect(provider.resumeRequests).toEqual([
      {
        req: {
          sessionId: 'session-1',
          addendumPromptPath: selectorRetry.addendumPromptPath,
          outputPath: req.outputPath,
          stdoutPath: req.stdoutPath,
          stderrPath: req.stderrPath,
          cwd: req.cwd,
          mode: req.mode,
          timeoutMs: req.timeoutMs,
        },
        agent: resolvedAgent,
      },
    ]);
    expect(result).toMatchObject({ outputExists: true, outputBytes: 54 });
    expect(result.failureKind).toBeUndefined();
  });

  it('applies the built-in default timeout to selector resume requests with a provider session', async () => {
    const req = await createRunRequest();
    const selectorRetry: AgentRunnerResumeRequest = {
      agentId: req.agentId,
      promptPath: req.promptPath,
      sessionId: 'session-1',
      addendumPromptPath: join(req.cwd, '.forgeroom', 'prompts', '01_plan.selector-retry.md'),
      outputPath: req.outputPath,
      stdoutPath: req.stdoutPath,
      stderrPath: req.stderrPath,
      cwd: req.cwd,
      mode: req.mode,
      attempt: 2,
    };
    const provider = new FakeAgentRuntimeProvider();
    provider.results = [providerResult({ durationMs: 80 })];
    const runner = new DefaultAgentRunner({
      agentRegistry: registry,
      provider,
      createRetryPrompt: () =>
        Promise.reject(new Error('selector retry should not need a second retry prompt')),
    });

    await writeOutput(req.outputPath, 'x'.repeat(54));
    await runner.resume(selectorRetry);

    expect(provider.resumeRequests).toEqual([
      {
        req: {
          sessionId: 'session-1',
          addendumPromptPath: selectorRetry.addendumPromptPath,
          outputPath: req.outputPath,
          stdoutPath: req.stdoutPath,
          stderrPath: req.stderrPath,
          cwd: req.cwd,
          mode: req.mode,
          timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
        },
        agent: resolvedAgent,
      },
    ]);
  });

  it('lets PipelineEngine continue selector failures with a new run when no session id exists', async () => {
    const req = await createRunRequest();
    const selectorRetry: AgentRunnerResumeRequest = {
      agentId: req.agentId,
      promptPath: req.promptPath,
      sessionId: null,
      addendumPromptPath: join(req.cwd, '.forgeroom', 'prompts', '01_plan.selector-retry.md'),
      outputPath: req.outputPath,
      stdoutPath: req.stdoutPath,
      stderrPath: req.stderrPath,
      cwd: req.cwd,
      mode: req.mode,
      attempt: 2,
      ...(req.timeoutMs === undefined ? {} : { timeoutMs: req.timeoutMs }),
    };
    const provider = new FakeAgentRuntimeProvider();
    provider.results = [providerResult({ sessionId: null })];
    const runner = new DefaultAgentRunner({ agentRegistry: registry, provider });

    await writeOutput(req.outputPath, 'x'.repeat(55));
    const result = await runner.resume(selectorRetry);

    expect(provider.runRequests).toEqual([
      {
        req: { ...req, promptPath: selectorRetry.addendumPromptPath },
        agent: resolvedAgent,
      },
    ]);
    expect(provider.resumeRequests).toEqual([]);
    expect(result).toMatchObject({ outputExists: true, outputBytes: 55 });
    expect(result.failureKind).toBeUndefined();
  });

  it('applies the built-in default timeout to selector resume fallback runs without a provider session', async () => {
    const req = await createRunRequest();
    const selectorRetry: AgentRunnerResumeRequest = {
      agentId: req.agentId,
      promptPath: req.promptPath,
      sessionId: null,
      addendumPromptPath: join(req.cwd, '.forgeroom', 'prompts', '01_plan.selector-retry.md'),
      outputPath: req.outputPath,
      stdoutPath: req.stdoutPath,
      stderrPath: req.stderrPath,
      cwd: req.cwd,
      mode: req.mode,
      attempt: 2,
    };
    const provider = new FakeAgentRuntimeProvider();
    provider.results = [providerResult({ sessionId: null })];
    const runner = new DefaultAgentRunner({ agentRegistry: registry, provider });

    await writeOutput(req.outputPath, 'x'.repeat(55));
    await runner.resume(selectorRetry);

    expect(provider.runRequests).toEqual([
      {
        req: { ...req, promptPath: selectorRetry.addendumPromptPath, timeoutMs: DEFAULT_AGENT_TIMEOUT_MS },
        agent: resolvedAgent,
      },
    ]);
    expect(provider.resumeRequests).toEqual([]);
  });

  it('preserves an explicit timeout on selector fallback runs without a provider session', async () => {
    const req = await createRunRequest();
    const selectorRetry: AgentRunnerResumeRequest = {
      agentId: req.agentId,
      promptPath: req.promptPath,
      sessionId: null,
      addendumPromptPath: join(req.cwd, '.forgeroom', 'prompts', '01_plan.selector-retry.md'),
      outputPath: req.outputPath,
      stdoutPath: req.stdoutPath,
      stderrPath: req.stderrPath,
      cwd: req.cwd,
      mode: req.mode,
      attempt: 2,
      timeoutMs: 42_000,
    };
    const provider = new FakeAgentRuntimeProvider();
    provider.results = [providerResult({ sessionId: null })];
    const runner = new DefaultAgentRunner({
      agentRegistry: registry,
      provider,
      defaultTimeoutMs: 123_000,
    });

    await writeOutput(req.outputPath, 'x'.repeat(55));
    await runner.resume(selectorRetry);

    expect(provider.runRequests).toEqual([
      {
        req: { ...req, promptPath: selectorRetry.addendumPromptPath, timeoutMs: 42_000 },
        agent: resolvedAgent,
      },
    ]);
    expect(provider.resumeRequests).toEqual([]);
  });

  it('retries timeout failures through the output-producing attempt budget', async () => {
    const req = await createRunRequest();
    const provider = new FakeAgentRuntimeProvider();
    provider.results = [
      providerResult({
        exitCode: 1,
        failureKind: 'timeout',
        outputExists: false,
        outputBytes: 0,
      }),
      providerResult(),
    ];
    const runner = new DefaultAgentRunner({
      agentRegistry: registry,
      provider,
      createRetryPrompt: async () => {
        await writeOutput(req.outputPath, 'x'.repeat(56));
        return join(req.cwd, '.forgeroom', 'prompts', '01_plan.retry-2.md');
      },
    });

    const result = await runner.run(req);

    expect(provider.runRequests).toHaveLength(1);
    expect(provider.resumeRequests).toHaveLength(1);
    expect(result.failureKind).toBeUndefined();
  });

  it('does not spend output retries on terminal provider readiness failures', async () => {
    const req = await createRunRequest();
    const provider = new FakeAgentRuntimeProvider();
    provider.results = [
      providerResult({
        exitCode: 1,
        failureKind: 'runtime_unavailable',
        outputExists: false,
        outputBytes: 0,
      }),
    ];
    const runner = new DefaultAgentRunner({ agentRegistry: registry, provider });

    const result = await runner.run(req);

    expect(provider.runRequests).toHaveLength(1);
    expect(provider.resumeRequests).toEqual([]);
    expect(result).toMatchObject({
      exitCode: 1,
      failureKind: 'runtime_unavailable',
      outputExists: false,
      outputBytes: 0,
    });
  });

  it('does not spend output retries on auth failures', async () => {
    const req = await createRunRequest();
    const provider = new FakeAgentRuntimeProvider();
    provider.results = [
      providerResult({
        exitCode: 1,
        failureKind: 'auth_failed',
        outputExists: false,
        outputBytes: 0,
      }),
    ];
    const runner = new DefaultAgentRunner({ agentRegistry: registry, provider });

    const result = await runner.run(req);

    expect(provider.runRequests).toHaveLength(1);
    expect(provider.resumeRequests).toEqual([]);
    expect(result).toMatchObject({
      exitCode: 1,
      failureKind: 'auth_failed',
      outputExists: false,
      outputBytes: 0,
    });
  });
});
