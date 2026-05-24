/**
 * Real OpenClaw IPC transport (#45 — reworked from the #31 convention).
 *
 * ADR-012 makes OpenClawProvider the MVP AgentRuntimeProvider; the provider is
 * REAL and provider-neutral. This module owns the subprocess transport that
 * drives the real OpenClaw CLI gateway, satisfying the {@link OpenClawIpcClient}
 * seam declared by `core/openclaw-provider.ts`.
 *
 * The contract was verified against a real OpenClaw install (2026.5.18). The
 * one-shot command is:
 *
 *   openclaw agent --json --agent <id> [--session-id <id>] --message <prompt> \
 *     [--model <provider/model>] [--timeout <seconds>]
 *
 * There is NO `openclaw exec`. The gateway runs on `http://127.0.0.1:18789`;
 * the token is passed via the `OPENCLAW_TOKEN` env var, never argv. The prompt
 * is passed inline (`--message`) — the adapter reads the ForgeRoom prompt file
 * (kept for audit) and passes its content. The agent returns a JSON envelope on
 * stdout; the adapter parses it, WRITES the reply text to the ForgeRoom output
 * file (the agent no longer writes a file), and surfaces the runtime session id
 * for AgentRunner resume.
 *
 * Per the core/ rules, `child_process` lives in this app/gateway adapter, never
 * in core. The client:
 *   1. reads the prompt file and builds the `agent --json` argv (`shell: false`,
 *      token via env);
 *   2. streams stdout/stderr to the request-provided log paths;
 *   3. enforces the timeout budget by SIGTERM-ing the process group, escalating
 *      to SIGKILL after a grace window (also forwarded as CLI `--timeout`);
 *   4. parses the JSON envelope: `status`, `result.payloads[].text`,
 *      `result.meta.agentMeta.sessionId`, `result.meta.completion.refusal`;
 *   5. writes the reply text to the output file and maps the outcome onto the
 *      common ForgeRoom `failureKind` set (runtime/timeout/agent_error). The
 *      runner owns `output_contract_failed`.
 *
 * The default argv (`["agent","--json"]`), agent id (`main`), and bin
 * (`openclaw`) are overridable via env so a differing install can be wired
 * without code changes. See `Docs/dev/openclaw-e2e.md`.
 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
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

/** Separator used to join multiple assistant payloads into one reply. */
const PAYLOAD_SEPARATOR = '\n\n';

/** A shell/wrapper "command not found" exit; treated as runtime unavailable. */
const EXIT_COMMAND_NOT_FOUND = 127;

/** Connection-refused signature in CLI stderr → the gateway is not reachable. */
const CONNECTION_REFUSED = /ECONNREFUSED|ECONNRESET|connection refused/i;

export interface OpenClawCliConfig {
  /** The OpenClaw CLI binary (FORGEROOM_OPENCLAW_BIN, default "openclaw"). */
  bin: string;
  /**
   * Leading argv inserted before the adapter-built flags
   * (FORGEROOM_OPENCLAW_ARGS as a JSON string array). Defaults to
   * `["agent","--json"]`.
   */
  baseArgs: string[];
  /** OpenClaw agent id (FORGEROOM_OPENCLAW_AGENT, default "main"). */
  agentId: string;
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
  agentId?: string | undefined;
}): OpenClawCliConfig {
  const bin = input.cliBin?.trim() || 'openclaw';
  const baseArgs = parseArgs(input.cliArgsJson) ?? ['agent', '--json'];
  const agentId = input.agentId?.trim() || 'main';
  return { bin, baseArgs, agentId };
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

  async run(request: OpenClawExecutionRequest): Promise<OpenClawRunResponse> {
    const message = await readFile(request.promptPath, 'utf8');
    return this.execute(this.buildArgs(request, message, null), request, null);
  }

  async resume(request: OpenClawResumeRequest): Promise<OpenClawRunResponse> {
    const message = await readFile(request.promptPath, 'utf8');
    return this.execute(this.buildArgs(request, message, request.sessionId), request, request.sessionId);
  }

  /**
   * Build `agent --json --agent <id> [--session-id <id>] --message <prompt>
   * [--model <model>] [--timeout <seconds>]`. The prompt content is passed
   * inline; for very large prompts this hits the OS argv-size limit (see PR
   * note) — the prompt file is still written for audit.
   */
  private buildArgs(
    request: OpenClawExecutionRequest,
    message: string,
    sessionId: string | null,
  ): string[] {
    const args = [...this.config.baseArgs, '--agent', request.agentId];
    if (sessionId !== null) {
      args.push('--session-id', sessionId);
    }
    args.push('--message', message);
    if (request.model.trim() !== '') {
      args.push('--model', request.model);
    }
    if (request.timeoutMs !== undefined) {
      args.push('--timeout', String(Math.ceil(request.timeoutMs / 1000)));
    }
    return args;
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
    const parsed = timedOut ? null : parseAgentJson(stdoutBuf);
    const sessionId = extractSessionId(parsed) ?? fallbackSessionId;

    const failureKind = classifyFailure({
      timedOut,
      spawnError,
      exitCode: rawExit,
      parsed,
      stderr: stderrBuf,
    });

    // Write the agent's reply to the ForgeRoom output file (the adapter owns
    // this now — the agent returns JSON, not a file). Skip on spawn/timeout
    // failures where there is no reply to persist.
    const output = await this.writeOutput(request.outputPath, parsed);

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

  /**
   * Write the reply text to the output file. Returns existence + byte size so
   * the runner's output-contract check sees what was produced. A refusal / agent
   * error may still carry reply text worth persisting; only spawn/timeout
   * failures with no parsed envelope skip the write.
   */
  private async writeOutput(
    outputPath: string,
    parsed: ParsedAgentJson | null,
  ): Promise<{ exists: boolean; bytes: number }> {
    const reply = extractReplyText(parsed);
    if (reply === null || reply === '') {
      // Nothing to write (timeout, spawn error, unparseable, or empty reply).
      return { exists: false, bytes: 0 };
    }
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, reply, 'utf8');
    try {
      const info = await stat(outputPath);
      return info.isFile() ? { exists: true, bytes: info.size } : { exists: false, bytes: 0 };
    } catch {
      return { exists: false, bytes: 0 };
    }
  }
}

// ---------------------------------------------------------------------------
// JSON envelope parsing (exported for direct unit testing)
// ---------------------------------------------------------------------------

/** The subset of the OpenClaw `agent --json` envelope the adapter reads. */
export type ParsedAgentJson = Record<string, unknown>;

/** Parse the CLI stdout as the OpenClaw JSON envelope; null on non-JSON. */
export function parseAgentJson(stdout: string): ParsedAgentJson | null {
  const trimmed = stdout.trim();
  if (trimmed === '') {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null ? (parsed as ParsedAgentJson) : null;
  } catch {
    return null;
  }
}

/**
 * Reply text = join of `result.payloads[].text` (blank-line separated), with a
 * fallback to `result.meta.finalAssistantVisibleText`.
 */
export function extractReplyText(parsed: ParsedAgentJson | null): string | null {
  if (parsed === null) {
    return null;
  }
  const result = asRecord(parsed['result']);
  if (result === null) {
    return null;
  }
  const payloads = result['payloads'];
  if (Array.isArray(payloads)) {
    const texts = payloads
      .map((payload) => asRecord(payload)?.['text'])
      .filter((text): text is string => typeof text === 'string' && text !== '');
    if (texts.length > 0) {
      return texts.join(PAYLOAD_SEPARATOR);
    }
  }
  const meta = asRecord(result['meta']);
  const finalText = meta?.['finalAssistantVisibleText'];
  return typeof finalText === 'string' && finalText !== '' ? finalText : null;
}

/**
 * Resume session id = `result.meta.agentMeta.sessionId`, falling back to
 * `result.meta.agentMeta.cliSessionBinding.sessionId`. Per #45 the agentMeta
 * sessionId is the resumable one to prefer.
 */
export function extractSessionId(parsed: ParsedAgentJson | null): string | null {
  if (parsed === null) {
    return null;
  }
  const agentMeta = asRecord(asRecord(asRecord(parsed['result'])?.['meta'])?.['agentMeta']);
  if (agentMeta === null) {
    return null;
  }
  const direct = agentMeta['sessionId'];
  if (typeof direct === 'string' && direct !== '') {
    return direct;
  }
  const binding = asRecord(agentMeta['cliSessionBinding'])?.['sessionId'];
  return typeof binding === 'string' && binding !== '' ? binding : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
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
  parsed: ParsedAgentJson | null;
  stderr: string;
}): AgentRunFailureKind | undefined {
  if (input.timedOut) {
    return 'timeout';
  }
  if (input.spawnError !== null) {
    return input.spawnError.code === 'ENOENT' ? 'runtime_unavailable' : 'agent_error';
  }
  if (input.exitCode === EXIT_COMMAND_NOT_FOUND) {
    return 'runtime_unavailable';
  }
  if (input.exitCode !== 0) {
    return CONNECTION_REFUSED.test(input.stderr) ? 'runtime_unavailable' : 'agent_error';
  }
  // Exit 0: trust the JSON envelope.
  const parsed = input.parsed;
  if (parsed === null) {
    return 'agent_error';
  }
  if (parsed['status'] !== 'ok') {
    return 'agent_error';
  }
  const completion = asRecord(asRecord(asRecord(parsed['result'])?.['meta'])?.['completion']);
  if (completion?.['refusal'] === true) {
    return 'agent_error';
  }
  return undefined;
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
