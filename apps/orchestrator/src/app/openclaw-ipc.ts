/**
 * Real OpenClaw IPC transport (#31).
 *
 * ADR-012 makes OpenClawProvider the MVP AgentRuntimeProvider; the provider is
 * REAL and provider-neutral. This module owns the subprocess transport that
 * actually drives the OpenClaw CLI runtime gateway, satisfying the
 * {@link OpenClawIpcClient} seam declared by `core/openclaw-provider.ts`.
 *
 * Per the core/ rules, `child_process` lives in this app/gateway adapter, never
 * in core. The provider passes a provider-neutral request (the file-based
 * execution contract: `cwd`, prompt/output instructions that point the agent at
 * the `.forgeroom/prompts` / `.forgeroom/outputs` files, plus stdout/stderr log
 * paths and a timeout budget) and this client:
 *
 *   1. spawns the OpenClaw CLI subprocess (`shell: false`, argv built from a
 *      documented ForgeRoom adapter convention; token passed via env, never
 *      argv);
 *   2. streams stdout/stderr to the request-provided log paths;
 *   3. enforces the timeout budget by SIGTERM-ing the process group, escalating
 *      to SIGKILL after a grace window;
 *   4. parses a strict session-id marker line from stdout so AgentRunner can
 *      `resume` the same session;
 *   5. measures the produced output file and maps the outcome onto the common
 *      ForgeRoom `failureKind` set (runtime/auth/timeout/agent_error). The
 *      runner owns `output_contract_failed`.
 *
 * The exact OpenClaw CLI invocation is NOT pinned by the project docs, so the
 * default argv + markers below are a *documented ForgeRoom adapter convention*,
 * not an upstream OpenClaw guarantee. They are overridable via env so a real
 * runtime whose CLI differs can be wired without code changes. See
 * `Docs/dev/openclaw-e2e.md`.
 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { finished } from 'node:stream/promises';

import type { AgentRunFailureKind, ProviderHealth } from '../core/agent-runner.js';
import type {
  OpenClawExecutionRequest,
  OpenClawHealthRequest,
  OpenClawIpcClient,
  OpenClawResumeRequest,
  OpenClawRunResponse,
} from '../core/openclaw-provider.js';

/** Grace window between SIGTERM and the escalation SIGKILL on timeout. */
const KILL_GRACE_MS = 200;

/** Strict marker lines the adapter parses out of the runtime's stdout/stderr. */
const SESSION_ID_MARKER = /^OPENCLAW_SESSION_ID=([A-Za-z0-9._:-]+)$/m;
const AUTH_FAILED_MARKER = /^OPENCLAW_AUTH_FAILED=1$/m;

/**
 * Documented exit-code convention for the ForgeRoom OpenClaw adapter. Marker
 * lines take precedence; these are the fallback when only an exit code is seen.
 */
const EXIT_AUTH_FAILED = 41;
/** A shell/wrapper "command not found" exit; treated as runtime unavailable. */
const EXIT_COMMAND_NOT_FOUND = 127;

export interface OpenClawCliConfig {
  /** The OpenClaw CLI binary (FORGEROOM_OPENCLAW_BIN, default "openclaw"). */
  bin: string;
  /**
   * Extra leading argv inserted before the adapter-built flags
   * (FORGEROOM_OPENCLAW_ARGS as a JSON string array). Lets a differing CLI be
   * wired without code changes. Defaults to `["exec"]`.
   */
  baseArgs: string[];
  /** Extra environment merged into the child (e.g. for the runtime). */
  extraEnv?: Record<string, string>;
}

/**
 * Build the CLI config from the already-resolved {@link OrchestratorEnv}
 * fields. config.ts owns reading `process.env`; this only parses the
 * adapter-owned args convention (so a malformed override fails at the adapter).
 */
export function resolveOpenClawCliConfig(input: {
  cliBin?: string | undefined;
  cliArgsJson?: string | undefined;
}): OpenClawCliConfig {
  const bin = input.cliBin?.trim() || 'openclaw';
  const baseArgs = parseArgs(input.cliArgsJson) ?? ['exec'];
  return { bin, baseArgs };
}

function parseArgs(raw: string | undefined): string[] | null {
  if (raw === undefined || raw.trim() === '') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OpenClawCliConfigError('FORGEROOM_OPENCLAW_ARGS must be a JSON array of strings');
  }
  if (!Array.isArray(parsed) || !parsed.every((item): item is string => typeof item === 'string')) {
    throw new OpenClawCliConfigError('FORGEROOM_OPENCLAW_ARGS must be a JSON array of strings');
  }
  return parsed;
}

export class OpenClawCliConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenClawCliConfigError';
  }
}

/** Seam over `spawn` so tests can drive lifecycle without a real CLI. */
export type Spawn = typeof spawn;

export interface OpenClawCliClientOptions {
  config: OpenClawCliConfig;
  /** Override for tests; defaults to node's `child_process.spawn`. */
  spawnFn?: Spawn;
  /** Wall-clock source (injectable for deterministic duration in tests). */
  now?: () => number;
}

/**
 * The real subprocess-backed IPC client. Replaces `NotWiredOpenClawIpcClient`.
 */
export class OpenClawCliClient implements OpenClawIpcClient {
  private readonly config: OpenClawCliConfig;
  private readonly spawnFn: Spawn;
  private readonly now: () => number;

  constructor(options: OpenClawCliClientOptions) {
    this.config = options.config;
    this.spawnFn = options.spawnFn ?? spawn;
    this.now = options.now ?? Date.now;
  }

  /**
   * Shallow readiness check (ADR-012): the configured fields are validated by
   * the provider; here we only confirm the CLI binary is resolvable. Real
   * auth/runtime failures surface through `run`/`resume`, not `health`.
   */
  async health(request: OpenClawHealthRequest): Promise<ProviderHealth> {
    const probe = await this.spawnProbe(request);
    if (probe.ok) {
      return { ok: true, message: `OpenClaw CLI '${this.config.bin}' resolved` };
    }
    return {
      ok: false,
      message: `OpenClaw CLI '${this.config.bin}' is not resolvable: ${probe.detail}`,
    };
  }

  run(request: OpenClawExecutionRequest): Promise<OpenClawRunResponse> {
    return this.execute(this.buildRunArgs(request), request, null);
  }

  resume(request: OpenClawResumeRequest): Promise<OpenClawRunResponse> {
    return this.execute(this.buildResumeArgs(request), request, request.sessionId);
  }

  private buildRunArgs(request: OpenClawExecutionRequest): string[] {
    return [
      ...this.config.baseArgs,
      '--runtime',
      request.runtime,
      '--model',
      request.model,
      '--cwd',
      request.cwd,
      '--mode',
      request.mode,
      '--message',
      `${request.promptInstruction} ${request.outputInstruction}`,
    ];
  }

  private buildResumeArgs(request: OpenClawResumeRequest): string[] {
    return [...this.buildRunArgs(request), '--session', request.sessionId];
  }

  private childEnv(request: OpenClawExecutionRequest): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ...this.config.extraEnv,
      OPENCLAW_ENDPOINT: request.endpoint,
      OPENCLAW_TOKEN: request.token,
    };
  }

  private async spawnProbe(request: OpenClawHealthRequest): Promise<{ ok: boolean; detail: string }> {
    return new Promise((resolve) => {
      const child = this.spawnFn(this.config.bin, [...this.config.baseArgs, '--version'], {
        env: {
          ...process.env,
          ...this.config.extraEnv,
          OPENCLAW_ENDPOINT: request.endpoint,
          OPENCLAW_TOKEN: request.token,
        },
        stdio: ['ignore', 'ignore', 'ignore'],
        shell: false,
      });
      child.once('error', (error: NodeJS.ErrnoException) => {
        resolve({ ok: false, detail: error.code ?? error.message });
      });
      child.once('close', (code) => {
        resolve(code === EXIT_COMMAND_NOT_FOUND ? { ok: false, detail: 'command not found' } : { ok: true, detail: '' });
      });
    });
  }

  private async execute(
    args: string[],
    request: OpenClawExecutionRequest,
    fallbackSessionId: string | null,
  ): Promise<OpenClawRunResponse> {
    await Promise.all([
      mkdir(dirname(request.stdoutPath), { recursive: true }),
      mkdir(dirname(request.stderrPath), { recursive: true }),
    ]);

    const startedAt = this.now();
    const stdout = createWriteStream(request.stdoutPath);
    const stderr = createWriteStream(request.stderrPath);

    const child = this.spawnFn(this.config.bin, args, {
      cwd: request.cwd,
      env: this.childEnv(request),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });
    child.stdout?.pipe(stdout);
    child.stderr?.pipe(stderr);

    let timedOut = false;
    let spawnError: NodeJS.ErrnoException | null = null;
    const timeoutMs = request.timeoutMs;

    const timeout =
      timeoutMs === undefined
        ? null
        : setTimeout(() => {
            timedOut = true;
            terminate(child.pid, 'SIGTERM');
          }, timeoutMs);
    const killTimer =
      timeoutMs === undefined
        ? null
        : setTimeout(() => {
            if (timedOut) {
              terminate(child.pid, 'SIGKILL');
            }
          }, timeoutMs + KILL_GRACE_MS);

    const rawExit = await new Promise<number>((resolve) => {
      child.once('error', (error: NodeJS.ErrnoException) => {
        spawnError = error;
        resolve(error.code === 'ENOENT' ? EXIT_COMMAND_NOT_FOUND : 1);
      });
      child.once('close', (code) => {
        resolve(code ?? 1);
      });
    });

    if (timeout !== null) {
      clearTimeout(timeout);
    }
    if (killTimer !== null) {
      clearTimeout(killTimer);
    }
    stdout.end();
    stderr.end();
    await Promise.all([finished(stdout), finished(stderr)]);

    const durationMs = this.now() - startedAt;
    const sessionId = SESSION_ID_MARKER.exec(stdoutBuf)?.[1] ?? fallbackSessionId;
    const output = await measureOutput(request.cwd, request.outputInstruction);

    const failureKind = classifyFailure({
      timedOut,
      spawnError,
      exitCode: rawExit,
      stdout: stdoutBuf,
      stderr: stderrBuf,
    });

    const response: OpenClawRunResponse = {
      exitCode: timedOut ? 1 : rawExit,
      output,
      durationMs,
      sessionId,
      stdoutPath: request.stdoutPath,
      stderrPath: request.stderrPath,
    };
    if (failureKind !== undefined) {
      response.failureKind = failureKind;
    }
    return response;
  }
}

/**
 * Map a finished subprocess onto the common ForgeRoom failure set. Exported so
 * the outcome contract is unit-tested directly. The provider/runner own output
 * validation; this never returns `output_contract_failed`.
 */
export function classifyFailure(input: {
  timedOut: boolean;
  spawnError: NodeJS.ErrnoException | null;
  exitCode: number;
  stdout: string;
  stderr: string;
}): AgentRunFailureKind | undefined {
  if (input.timedOut) {
    return 'timeout';
  }
  if (input.spawnError !== null) {
    return input.spawnError.code === 'ENOENT' ? 'runtime_unavailable' : 'agent_error';
  }
  if (AUTH_FAILED_MARKER.test(input.stdout) || AUTH_FAILED_MARKER.test(input.stderr)) {
    return 'auth_failed';
  }
  if (input.exitCode === EXIT_AUTH_FAILED) {
    return 'auth_failed';
  }
  if (input.exitCode === EXIT_COMMAND_NOT_FOUND) {
    return 'runtime_unavailable';
  }
  if (input.exitCode !== 0) {
    return 'agent_error';
  }
  return undefined;
}

/**
 * The output file the agent was told to write. We recover its path from the
 * `outputInstruction` ("Write your response to <path>.") so the provider need
 * not change its provider-neutral shape. Returns existence + byte size.
 */
async function measureOutput(
  cwd: string,
  outputInstruction: string,
): Promise<{ exists: boolean; bytes: number }> {
  const outputPath = parseOutputPath(outputInstruction);
  if (outputPath === null) {
    return { exists: false, bytes: 0 };
  }
  const resolved = outputPath.startsWith('/') ? outputPath : `${cwd}/${outputPath}`;
  try {
    const info = await stat(resolved);
    return info.isFile() ? { exists: true, bytes: info.size } : { exists: false, bytes: 0 };
  } catch {
    return { exists: false, bytes: 0 };
  }
}

export function parseOutputPath(outputInstruction: string): string | null {
  const match = /Write your response to (.+?)\.?$/.exec(outputInstruction.trim());
  return match?.[1]?.trim() ?? null;
}

function terminate(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    try {
      process.kill(pid, signal);
    } catch {
      // Process may have exited between timeout firing and signal delivery.
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Process may have exited between timeout firing and signal delivery.
    }
  }
}
