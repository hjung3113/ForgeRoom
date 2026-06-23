/**
 * Real OpenClaw IPC transport (#45 — reworked from the #31 convention).
 *
 * ADR-012 makes OpenClawProvider the MVP AgentRuntimeProvider; the provider is
 * REAL and provider-neutral. This module owns the subprocess transport that
 * drives the real OpenClaw CLI gateway, satisfying the {@link OpenClawIpcClient}
 * seam declared by `app/openclaw-provider.ts`.
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
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { AgentRunFailureKind, ProviderHealth } from '../core/agent-runtime/agent-runner.js';
import type {
  OpenClawAgentAddRequest,
  OpenClawAgentDeleteRequest,
  OpenClawExecutionRequest,
  OpenClawHealthRequest,
  OpenClawIpcClient,
  OpenClawResumeRequest,
  OpenClawRunResponse,
} from './openclaw-provider.js';
import { spawnCaptured } from '../utils/subprocess.js';

/** Grace window between SIGTERM and the escalation SIGKILL on timeout. */
const KILL_GRACE_MS = 200;

/** Separator used to join multiple assistant payloads into one reply. */
const PAYLOAD_SEPARATOR = '\n\n';

/** A shell/wrapper "command not found" exit; treated as runtime unavailable. */
const EXIT_COMMAND_NOT_FOUND = 127;

/** Connection-refused signature in CLI stderr → the gateway is not reachable. */
const CONNECTION_REFUSED = /ECONNREFUSED|ECONNRESET|connection refused/i;

/** `agents add` output signature for an already-configured agent (idempotent create). */
const AGENT_ALREADY_EXISTS = /already exists/i;

/** `agents delete` output signature for a missing agent (idempotent delete). */
const AGENT_NOT_FOUND = /not found/i;

/** Raised when an `agents` lifecycle command fails for a non-idempotent reason. */
export class OpenClawAgentLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenClawAgentLifecycleError';
  }
}

export interface OpenClawCliConfig {
  /** The OpenClaw CLI binary (FORGEROOM_OPENCLAW_BIN, default "openclaw"). */
  bin: string;
  /**
   * Leading argv inserted before the adapter-built flags
   * (FORGEROOM_OPENCLAW_ARGS as a JSON string array). Defaults to
   * `["agent","--json"]`.
   */
  baseArgs: string[];
  /**
   * Leading argv for the `agents` subcommand (ADR-030 lifecycle add/delete).
   * Defaults to `["agents"]`; tests point it at a fake CLI script. The `agent`
   * (run) and `agents` (lifecycle) subcommands are distinct, so they carry
   * separate base args rather than sharing {@link baseArgs}.
   */
  agentsBaseArgs: string[];
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
  return { bin, baseArgs, agentsBaseArgs: ['agents'], agentId };
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
   * Create the per-task ephemeral agent bound to its worktree (ADR-030):
   * `agents add <id> --workspace <dir> --non-interactive --json`. Idempotent —
   * an "already exists" failure (re-create on resume/recovery) is treated as
   * success; any other nonzero exit throws so a run never silently loses its
   * workspace binding and falls back to the global `main` agent.
   */
  async addAgent(request: OpenClawAgentAddRequest): Promise<void> {
    const args = [
      ...this.config.agentsBaseArgs,
      'add',
      request.agentId,
      '--workspace',
      request.workspace,
      '--non-interactive',
      '--json',
    ];
    const { exitCode, output } = await this.spawnLifecycle(args, request);
    if (exitCode === 0 || AGENT_ALREADY_EXISTS.test(output)) {
      return;
    }
    throw new OpenClawAgentLifecycleError(
      `failed to create OpenClaw agent ${request.agentId}: ${output.trim() || `exit ${exitCode}`}`,
    );
  }

  /**
   * Delete the per-task agent (`agents delete <id> --force --json`). Idempotent —
   * a "not found" failure is treated as success (the agent is already gone), so
   * delete-on-terminal-settle is safe to call unconditionally.
   */
  async deleteAgent(request: OpenClawAgentDeleteRequest): Promise<void> {
    const args = [...this.config.agentsBaseArgs, 'delete', request.agentId, '--force', '--json'];
    const { exitCode, output } = await this.spawnLifecycle(args, request);
    if (exitCode === 0 || AGENT_NOT_FOUND.test(output)) {
      return;
    }
    throw new OpenClawAgentLifecycleError(
      `failed to delete OpenClaw agent ${request.agentId}: ${output.trim() || `exit ${exitCode}`}`,
    );
  }

  /**
   * Run a fire-and-forget `agents` lifecycle command, capturing combined
   * stdout+stderr (the CLI prints its "already exists"/"not found" message there,
   * not always as JSON). NODE_OPTIONS is stripped like the run path so the child
   * Node CLI does not inherit our loaders (see {@link sanitizedParentEnv}).
   */
  private spawnLifecycle(
    args: string[],
    request: { endpoint: string; token: string },
  ): Promise<{ exitCode: number; output: string }> {
    return new Promise((resolve) => {
      const child = this.spawnFn(this.config.bin, args, {
        env: {
          ...sanitizedParentEnv(),
          ...this.config.extraEnv,
          OPENCLAW_ENDPOINT: request.endpoint,
          OPENCLAW_TOKEN: request.token,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });
      let output = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
      child.once('error', (error: NodeJS.ErrnoException) => {
        resolve({ exitCode: EXIT_COMMAND_NOT_FOUND, output: error.message });
      });
      child.once('close', (code) => {
        resolve({ exitCode: code ?? 1, output });
      });
    });
  }

  /**
   * Build `agent --json --agent <id> [--session-id <id>] --message <prompt>
   * [--model <runtime/modelBase>] [--timeout <seconds>]`. The `--model` value is
   * derived from the runtime via {@link deriveModelArg} (OpenClaw names models by
   * runtime, not vendor — #47). The prompt content is passed inline; for very
   * large prompts this hits the OS argv-size limit (see PR note) — the prompt
   * file is still written for audit.
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
    const model = deriveModelArg(request.model);
    if (model !== null) {
      args.push('--model', model);
    }
    if (request.timeoutMs !== undefined) {
      args.push('--timeout', String(Math.ceil(request.timeoutMs / 1000)));
    }
    return args;
  }

  private childEnv(request: OpenClawExecutionRequest): NodeJS.ProcessEnv {
    return {
      ...sanitizedParentEnv(),
      ...this.config.extraEnv,
      OPENCLAW_ENDPOINT: request.endpoint,
      OPENCLAW_TOKEN: request.token,
    };
  }

  private async spawnProbe(request: OpenClawHealthRequest): Promise<{ ok: boolean; detail: string }> {
    return new Promise((resolve) => {
      const child = this.spawnFn(this.config.bin, [...this.config.baseArgs, '--version'], {
        env: {
          ...sanitizedParentEnv(),
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
    const result = await spawnCaptured({
      bin: this.config.bin,
      args,
      cwd: request.cwd,
      env: this.childEnv(request),
      shell: false,
      stdoutPath: request.stdoutPath,
      stderrPath: request.stderrPath,
      capture: true,
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      killGraceMs: KILL_GRACE_MS,
      spawnFn: this.spawnFn,
      now: this.now,
      writeSpawnErrorToStderr: false,
    });
    const rawExit = result.spawnError?.code === 'ENOENT' ? EXIT_COMMAND_NOT_FOUND : result.rawExit;
    const stdoutBuf = result.stdoutBuf;
    const stderrBuf = result.stderrBuf;
    const timedOut = result.timedOut;
    const spawnError = result.spawnError;
    const durationMs = result.durationMs;
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
// Model-id derivation (exported for direct unit testing)
// ---------------------------------------------------------------------------

/**
 * The OpenClaw `--model` value is the agent's configured model id passed through
 * VERBATIM. OpenClaw owns model naming and it is NOT uniform across runtimes
 * (`claude-cli/claude-opus-4-7` for the claude-cli runtime, `openai/gpt-5.5` for
 * the codex runtime), so ForgeRoom does not transform it — `agents.yaml` /
 * `model-policies.yaml` carry the exact id OpenClaw expects (provider is always
 * OpenClaw, ADR-012). An earlier heuristic re-prefixed the model base with the
 * runtime (#47); that assumed uniform `runtime/base` naming and mangled the
 * codex `openai/...` ids, so it was removed.
 *
 * Returns `null` when there is no model to pass (empty), so `--model` is omitted
 * and OpenClaw uses the agent's default model.
 */
export function deriveModelArg(model: string): string | null {
  const trimmed = model.trim();
  return trimmed === '' ? null : trimmed;
}

// ---------------------------------------------------------------------------
// JSON envelope parsing (exported for direct unit testing)
// ---------------------------------------------------------------------------

/** The subset of the OpenClaw `agent --json` envelope the adapter reads. */
export type ParsedAgentJson = Record<string, unknown>;

/** Parse the CLI stdout as the OpenClaw JSON envelope; null on non-JSON. */
/**
 * Parent env to hand a spawned OpenClaw CLI, minus host-process injection that
 * would corrupt it. `openclaw` is itself a Node CLI, so inheriting our
 * `NODE_OPTIONS` (e.g. vitest's `--import` loader, or any `--require` hook)
 * makes the child Node load our instrumentation and emit no/garbled stdout —
 * which the adapter then sees as an empty JSON envelope (`agent_error`).
 * Stripping it is correct for any external CLI, and is what made the live e2e
 * pass under vitest.
 */
export function sanitizedParentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { NODE_OPTIONS: _nodeOptions, ...rest } = env;
  return rest;
}

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
