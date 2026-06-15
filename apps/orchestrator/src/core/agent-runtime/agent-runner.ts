import { mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

import type { OrchestratorFailureCode } from '../errors.js';
import type { AgentRegistry, ResolvedAgent } from './agent-registry.js';

export type AgentRunFailureKind = Extract<
  OrchestratorFailureCode,
  'runtime_unavailable' | 'auth_failed' | 'timeout' | 'agent_error' | 'output_contract_failed'
>;

/**
 * Provider-neutral execution target (ADR-023). Carries WHICH runtime/model a
 * step runs on, decoupled from `ResolvedAgent`. ModelPolicyRegistry (#62) will
 * produce these; until then DefaultAgentRunner derives one from the resolved
 * agent. RuntimeCapabilities is intentionally out of scope.
 */
export interface ResolvedRuntimeTarget {
  /** Maps from `ResolvedAgent.provider` (e.g. 'openclaw'). */
  providerId: string;
  runtime: string;
  model: string;
  permissionProfile?: string;
}

/**
 * Per-run provider session/identity (ADR-028 Project Room seam). Separate from
 * {@link ResolvedRuntimeTarget} (which owns runtime/model/permissionProfile):
 * this carries WHICH provider-native session/agent a run uses, resolved from the
 * project room + step role.
 *
 * - `providerAgentId`: the provider-native (OpenClaw `--agent`) id, distinct
 *   from `AgentRunRequest.agentId` (the ForgeRoom AgentRegistry id). A provider
 *   prefers it over its global fallback agent.
 * - `sessionKey` / `role`: ForgeRoom-side logical metadata. OpenClaw has no
 *   session-key flag, so these never reach the CLI; they are carried for
 *   TaskStore persistence (#86) and operator visibility. The resumable session
 *   id stays in the existing run-result / resume path (runtime-assigned).
 */
export interface RuntimeSession {
  providerAgentId?: string;
  sessionKey?: string;
  role?: string;
}

export interface AgentRunRequest {
  agentId: string;
  promptPath: string;
  outputPath: string;
  stdoutPath: string;
  stderrPath: string;
  cwd: string;
  mode: 'headless' | 'pty';
  timeoutMs?: number;
  /**
   * Provider-neutral runtime/model target (ADR-023). When present a provider
   * prefers it over `ResolvedAgent`; absent, the provider falls back to the
   * resolved agent's runtime/model.
   */
  runtimeTarget?: ResolvedRuntimeTarget;
  /** Per-run provider session/agent (ADR-028). See {@link RuntimeSession}. */
  runtimeSession?: RuntimeSession;
}

type AgentRunRequestWithTimeout = AgentRunRequest & {
  timeoutMs: number;
};

export type AgentResumeRequest = Omit<AgentRunRequest, 'agentId' | 'promptPath'> & {
  sessionId: string;
  addendumPromptPath: string;
};

export type AgentRunnerResumeRequest = Omit<AgentResumeRequest, 'sessionId'> & {
  agentId: string;
  promptPath: string;
  sessionId: string | null;
  attempt: number;
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

export interface AgentRunner {
  run(req: AgentRunRequest): Promise<AgentRunResult>;
  resume(req: AgentRunnerResumeRequest): Promise<AgentRunResult>;
}

export interface RetryPromptContext {
  attempt: number;
  previousResult: AgentRunResult;
  request: AgentRunRequest;
}

export interface DefaultAgentRunnerOptions {
  agentRegistry: AgentRegistry;
  provider: AgentRuntimeProvider;
  minOutputBytes?: number;
  maxAttempts?: number;
  defaultTimeoutMs?: number;
  createRetryPrompt?: (context: RetryPromptContext) => Promise<string>;
}

const DEFAULT_MIN_OUTPUT_BYTES = 50;
const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_AGENT_TIMEOUT_MS = 300_000;
const TERMINAL_PROVIDER_FAILURES = new Set<AgentRunFailureKind>([
  'runtime_unavailable',
  'auth_failed',
]);
const RETRYABLE_PROVIDER_FAILURES = new Set<AgentRunFailureKind>([
  'timeout',
  'agent_error',
  'output_contract_failed',
]);

export class DefaultAgentRunner implements AgentRunner {
  private readonly agentRegistry: AgentRegistry;
  private readonly provider: AgentRuntimeProvider;
  private readonly minOutputBytes: number;
  private readonly maxAttempts: number;
  private readonly defaultTimeoutMs: number;
  private readonly createRetryPrompt: (context: RetryPromptContext) => Promise<string>;

  constructor(options: DefaultAgentRunnerOptions) {
    this.agentRegistry = options.agentRegistry;
    this.provider = options.provider;
    this.minOutputBytes = options.minOutputBytes ?? DEFAULT_MIN_OUTPUT_BYTES;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    this.createRetryPrompt = options.createRetryPrompt ?? writeDefaultRetryPrompt;
  }

  async run(req: AgentRunRequest): Promise<AgentRunResult> {
    const agent = this.agentRegistry.resolve(req.agentId);
    const runRequest = withRuntimeTarget(withDefaultTimeout(req, this.defaultTimeoutMs), agent);
    const result = await this.provider.run(runRequest, agent);

    return this.completeOutputAttempts({
      req: runRequest,
      agent,
      result,
      attempt: 1,
    });
  }

  async resume(req: AgentRunnerResumeRequest): Promise<AgentRunResult> {
    const agent = this.agentRegistry.resolve(req.agentId);
    const runRequest = withRuntimeTarget(withDefaultTimeout(toRunRequest(req), this.defaultTimeoutMs), agent);
    const result = req.sessionId
      ? await this.provider.resume(
          toProviderResumeRequest(req, req.sessionId, runRequest.timeoutMs, runRequest.runtimeTarget),
          agent,
        )
      : await this.provider.run({ ...runRequest, promptPath: req.addendumPromptPath }, agent);

    return this.completeOutputAttempts({
      req: runRequest,
      agent,
      result,
      attempt: req.attempt,
    });
  }

  private async completeOutputAttempts(context: {
    req: AgentRunRequest;
    agent: ResolvedAgent;
    result: AgentRunResult;
    attempt: number;
  }): Promise<AgentRunResult> {
    const { req, agent } = context;
    let result = context.result;

    for (let attempt = context.attempt; attempt <= this.maxAttempts; attempt += 1) {
      if (isTerminalProviderFailure(result.failureKind)) {
        return result;
      }

      const validation = await validateOutputFile(req.outputPath, this.minOutputBytes);
      result = withOutputValidation(result, validation);
      if (validation.valid && !isRetryableProviderFailure(result.failureKind)) {
        return result;
      }

      if (attempt === this.maxAttempts) {
        return {
          ...result,
          failureKind: result.failureKind ?? 'output_contract_failed',
        };
      }

      const retryPromptPath = await this.createRetryPrompt({
        attempt: attempt + 1,
        previousResult: result,
        request: req,
      });

      if (result.sessionId) {
        result = await this.provider.resume(toRetryResumeRequest(req, result.sessionId, retryPromptPath), agent);
      } else {
        result = await this.provider.run({ ...req, promptPath: retryPromptPath }, agent);
      }
    }

    return {
      ...result,
      failureKind: 'output_contract_failed',
    };
  }
}

interface OutputValidation {
  valid: boolean;
  exists: boolean;
  bytes: number;
}

async function validateOutputFile(outputPath: string, minOutputBytes: number): Promise<OutputValidation> {
  try {
    const outputStat = await stat(outputPath);
    const bytes = outputStat.isFile() ? outputStat.size : 0;

    return {
      valid: outputStat.isFile() && bytes >= minOutputBytes,
      exists: outputStat.isFile(),
      bytes,
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { valid: false, exists: false, bytes: 0 };
    }

    throw error;
  }
}

function withOutputValidation(result: AgentRunResult, validation: OutputValidation): AgentRunResult {
  return {
    ...result,
    outputExists: validation.exists,
    outputBytes: validation.bytes,
  };
}

function isTerminalProviderFailure(failureKind: AgentRunFailureKind | undefined): boolean {
  return failureKind !== undefined && TERMINAL_PROVIDER_FAILURES.has(failureKind);
}

function isRetryableProviderFailure(failureKind: AgentRunFailureKind | undefined): boolean {
  return failureKind !== undefined && RETRYABLE_PROVIDER_FAILURES.has(failureKind);
}

function toRetryResumeRequest(
  req: AgentRunRequest,
  sessionId: string,
  addendumPromptPath: string,
): AgentResumeRequest {
  return {
    sessionId,
    addendumPromptPath,
    outputPath: req.outputPath,
    stdoutPath: req.stdoutPath,
    stderrPath: req.stderrPath,
    cwd: req.cwd,
    mode: req.mode,
    ...(req.timeoutMs === undefined ? {} : { timeoutMs: req.timeoutMs }),
    ...(req.runtimeTarget === undefined ? {} : { runtimeTarget: req.runtimeTarget }),
    ...(req.runtimeSession === undefined ? {} : { runtimeSession: req.runtimeSession }),
  };
}

function toProviderResumeRequest(
  req: AgentRunnerResumeRequest,
  sessionId: string,
  timeoutMs: number,
  runtimeTarget: ResolvedRuntimeTarget | undefined,
): AgentResumeRequest {
  return {
    sessionId,
    addendumPromptPath: req.addendumPromptPath,
    outputPath: req.outputPath,
    stdoutPath: req.stdoutPath,
    stderrPath: req.stderrPath,
    cwd: req.cwd,
    mode: req.mode,
    timeoutMs,
    ...(runtimeTarget === undefined ? {} : { runtimeTarget }),
    ...(req.runtimeSession === undefined ? {} : { runtimeSession: req.runtimeSession }),
  };
}

function toRunRequest(req: AgentRunnerResumeRequest): AgentRunRequest {
  return {
    agentId: req.agentId,
    promptPath: req.promptPath,
    outputPath: req.outputPath,
    stdoutPath: req.stdoutPath,
    stderrPath: req.stderrPath,
    cwd: req.cwd,
    mode: req.mode,
    ...(req.timeoutMs === undefined ? {} : { timeoutMs: req.timeoutMs }),
    ...(req.runtimeSession === undefined ? {} : { runtimeSession: req.runtimeSession }),
  };
}

function withDefaultTimeout(req: AgentRunRequest, defaultTimeoutMs: number): AgentRunRequestWithTimeout {
  return {
    ...req,
    timeoutMs: req.timeoutMs ?? defaultTimeoutMs,
  };
}

/** Provider-neutral target derived from the resolved agent (ADR-023). */
function runtimeTargetFor(agent: ResolvedAgent): ResolvedRuntimeTarget {
  return { providerId: agent.provider, runtime: agent.runtime, model: agent.model };
}

/**
 * Ensure the request carries a runtime target. An explicit caller-provided
 * target (e.g. from a future ModelPolicyRegistry) wins; otherwise derive one
 * from the resolved agent so providers always receive a target.
 */
function withRuntimeTarget<T extends AgentRunRequest>(req: T, agent: ResolvedAgent): T {
  if (req.runtimeTarget !== undefined) {
    return req;
  }
  return { ...req, runtimeTarget: runtimeTargetFor(agent) };
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

async function writeDefaultRetryPrompt(context: RetryPromptContext): Promise<string> {
  const promptPath = retryPromptPath(context.request.promptPath, context.attempt);
  await mkdir(dirname(promptPath), { recursive: true });
  await writeFile(
    promptPath,
    `Your previous response was not saved to ${context.request.outputPath}. Save the response to that file now.\n`,
  );

  return promptPath;
}

function retryPromptPath(promptPath: string, attempt: number): string {
  const extension = extname(promptPath) || '.md';
  const base = basename(promptPath, extname(promptPath));

  return join(dirname(promptPath), `${base}.retry-${String(attempt)}${extension}`);
}
