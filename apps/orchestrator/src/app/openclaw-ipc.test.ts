import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { OpenClawExecutionRequest } from './openclaw-provider.js';
import {
  OpenClawCliClient,
  OpenClawCliConfigError,
  classifyFailure,
  deriveModelArg,
  extractReplyText,
  extractSessionId,
  parseAgentJson,
  resolveOpenClawCliConfig,
  sanitizedParentEnv,
} from './openclaw-ipc.js';

// A fake `openclaw agent --json` CLI: a node script driven by FAKE_OPENCLAW_MODE.
// It emits the REAL OpenClaw 2026.5.18 JSON envelope on stdout (status / result
// with payloads + meta.agentMeta.sessionId + meta.completion), so the adapter's
// argv build, JSON parse, output-file write, session-id surface, and error
// mapping are exercised end to end against a real child process.
const FAKE_CLI = `
const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }
const mode = process.env.FAKE_OPENCLAW_MODE || 'ok';
const message = arg('--message') || '';
const session = arg('--session-id') || 'fake-session-1';
function envelope(extra) {
  return JSON.stringify(Object.assign({
    status: 'ok',
    result: {
      payloads: [{ text: 'fake agent output that is well over fifty bytes long for the runner.' }],
      meta: {
        finalAssistantVisibleText: 'fake agent output that is well over fifty bytes long for the runner.',
        agentMeta: { sessionId: session, cliSessionBinding: { sessionId: session + '-cli' } },
        completion: { refusal: false, finishReason: 'stop' },
        durationMs: 1234,
      },
    },
  }, extra));
}
if (mode === 'ok') {
  process.stdout.write(envelope({}));
  process.exit(0);
} else if (mode === 'echo_message') {
  // Echo the received --message back inside the reply text for argv assertions.
  process.stdout.write(JSON.stringify({
    status: 'ok',
    result: { payloads: [{ text: 'MSG:' + message }], meta: { agentMeta: { sessionId: session } } },
  }));
  process.exit(0);
} else if (mode === 'echo_model') {
  // Echo the received --model back inside the reply text for argv assertions.
  process.stdout.write(JSON.stringify({
    status: 'ok',
    result: { payloads: [{ text: 'MODEL:' + (arg('--model') || '<none>') }], meta: { agentMeta: { sessionId: session } } },
  }));
  process.exit(0);
} else if (mode === 'multi') {
  process.stdout.write(JSON.stringify({
    status: 'ok',
    result: { payloads: [{ text: 'first chunk' }, { text: 'second chunk' }], meta: { agentMeta: { sessionId: session } } },
  }));
  process.exit(0);
} else if (mode === 'refusal') {
  process.stdout.write(JSON.stringify({
    status: 'ok',
    result: { payloads: [{ text: 'I cannot help with that.' }], meta: { agentMeta: { sessionId: session }, completion: { refusal: true, finishReason: 'refusal' } } },
  }));
  process.exit(0);
} else if (mode === 'not_ok') {
  process.stdout.write(JSON.stringify({ status: 'error', error: { message: 'gateway said no' } }));
  process.exit(0);
} else if (mode === 'nonzero') {
  process.stderr.write('boom\\n');
  process.exit(7);
} else if (mode === 'refused_conn') {
  process.stderr.write('connect ECONNREFUSED 127.0.0.1:18789\\n');
  process.exit(1);
} else if (mode === 'hang') {
  setTimeout(() => process.exit(0), 60000);
}
`;

let workdir: string;
let cliPath: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'openclaw-ipc-'));
  cliPath = join(workdir, 'fake-openclaw.cjs');
  await writeFile(cliPath, FAKE_CLI);
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

async function request(overrides: Partial<OpenClawExecutionRequest> = {}): Promise<OpenClawExecutionRequest> {
  const promptPath = join(workdir, 'prompts', '01_plan.md');
  const outputPath = join(workdir, 'outputs', '01_plan.md');
  if (overrides.promptPath === undefined) {
    await writeFile(join(workdir, 'prompts', '01_plan.md'), 'Plan the work.', { flag: 'w' }).catch(async () => {
      await import('node:fs/promises').then((fs) => fs.mkdir(join(workdir, 'prompts'), { recursive: true }));
      await writeFile(promptPath, 'Plan the work.');
    });
  }
  return {
    endpoint: 'http://127.0.0.1:18789',
    token: 'tok',
    runtime: 'claude-cli',
    model: 'anthropic/claude-opus-4-7',
    agentId: 'main',
    cwd: workdir,
    mode: 'headless',
    promptPath,
    outputPath,
    stdoutPath: join(workdir, 'logs', '01.stdout.log'),
    stderrPath: join(workdir, 'logs', '01.stderr.log'),
    timeoutMs: 5_000,
    ...overrides,
  };
}

function client(mode: string): OpenClawCliClient {
  return new OpenClawCliClient({
    config: { bin: process.execPath, baseArgs: [cliPath, 'agent', '--json'], agentId: 'main', extraEnv: { FAKE_OPENCLAW_MODE: mode } },
  });
}

describe('sanitizedParentEnv', () => {
  it('strips NODE_OPTIONS so a spawned node CLI does not inherit our loaders', () => {
    const out = sanitizedParentEnv({ NODE_OPTIONS: '--import /x/loader.mjs', PATH: '/usr/bin', FOO: 'bar' });
    expect(out.NODE_OPTIONS).toBeUndefined();
    expect(out.PATH).toBe('/usr/bin');
    expect(out.FOO).toBe('bar');
  });
});

describe('deriveModelArg', () => {
  it('re-prefixes the model base with the runtime (claude-cli + anthropic vendor)', () => {
    expect(deriveModelArg('claude-cli', 'anthropic/claude-opus-4-7')).toBe('claude-cli/claude-opus-4-7');
  });

  it('re-prefixes the model base with the runtime (openai-codex + openai vendor)', () => {
    expect(deriveModelArg('openai-codex', 'openai/gpt-5')).toBe('openai-codex/gpt-5');
  });

  it('prefixes a model with no vendor segment with the runtime', () => {
    expect(deriveModelArg('claude-cli', 'claude-opus-4-7')).toBe('claude-cli/claude-opus-4-7');
  });

  it('falls back to the raw model when the runtime is empty', () => {
    expect(deriveModelArg('', 'anthropic/claude-opus-4-7')).toBe('anthropic/claude-opus-4-7');
    expect(deriveModelArg('   ', 'anthropic/claude-opus-4-7')).toBe('anthropic/claude-opus-4-7');
  });

  it('returns null when there is no model to pass', () => {
    expect(deriveModelArg('claude-cli', '')).toBeNull();
    expect(deriveModelArg('claude-cli', '   ')).toBeNull();
  });
});

describe('resolveOpenClawCliConfig', () => {
  it('defaults bin to openclaw, base args to agent --json, and agent to main', () => {
    expect(resolveOpenClawCliConfig({})).toEqual({
      bin: 'openclaw',
      baseArgs: ['agent', '--json'],
      agentId: 'main',
    });
  });

  it('honours overrides', () => {
    expect(
      resolveOpenClawCliConfig({ cliBin: 'oc', cliArgsJson: '["agent","--json"]', agentId: 'reviewer' }),
    ).toEqual({
      bin: 'oc',
      baseArgs: ['agent', '--json'],
      agentId: 'reviewer',
    });
  });

  it('rejects non-array JSON', () => {
    expect(() => resolveOpenClawCliConfig({ cliArgsJson: '{"a":1}' })).toThrow(OpenClawCliConfigError);
  });

  it('rejects malformed JSON', () => {
    expect(() => resolveOpenClawCliConfig({ cliArgsJson: 'not json' })).toThrow(OpenClawCliConfigError);
  });
});

describe('parseAgentJson + extractors', () => {
  it('extracts the session id from agentMeta.sessionId, preferred over cliSessionBinding', () => {
    const parsed = parseAgentJson(
      JSON.stringify({
        status: 'ok',
        result: { meta: { agentMeta: { sessionId: 'agent-sid', cliSessionBinding: { sessionId: 'cli-sid' } } } },
      }),
    );
    expect(extractSessionId(parsed)).toBe('agent-sid');
  });

  it('falls back to cliSessionBinding.sessionId when agentMeta.sessionId is absent', () => {
    const parsed = parseAgentJson(
      JSON.stringify({ status: 'ok', result: { meta: { agentMeta: { cliSessionBinding: { sessionId: 'cli-sid' } } } } }),
    );
    expect(extractSessionId(parsed)).toBe('cli-sid');
  });

  it('joins multiple payload texts with a blank line', () => {
    const parsed = parseAgentJson(
      JSON.stringify({ status: 'ok', result: { payloads: [{ text: 'a' }, { text: 'b' }] } }),
    );
    expect(extractReplyText(parsed)).toBe('a\n\nb');
  });

  it('falls back to finalAssistantVisibleText when payloads are empty', () => {
    const parsed = parseAgentJson(
      JSON.stringify({ status: 'ok', result: { payloads: [], meta: { finalAssistantVisibleText: 'final text' } } }),
    );
    expect(extractReplyText(parsed)).toBe('final text');
  });

  it('returns null on non-JSON stdout', () => {
    expect(parseAgentJson('not json at all')).toBeNull();
  });
});

describe('classifyFailure', () => {
  const base = {
    timedOut: false,
    spawnError: null,
    exitCode: 0,
    parsed: { status: 'ok' } as Record<string, unknown>,
    stderr: '',
  };

  it('maps a clean ok envelope to no failure', () => {
    expect(classifyFailure(base)).toBeUndefined();
  });

  it('maps a timeout', () => {
    expect(classifyFailure({ ...base, timedOut: true })).toBe('timeout');
  });

  it('maps ENOENT spawn errors to runtime_unavailable', () => {
    const err = Object.assign(new Error('nope'), { code: 'ENOENT' });
    expect(classifyFailure({ ...base, spawnError: err })).toBe('runtime_unavailable');
  });

  it('maps a refusal completion to agent_error', () => {
    const parsed = { status: 'ok', result: { meta: { completion: { refusal: true } } } };
    expect(classifyFailure({ ...base, parsed })).toBe('agent_error');
  });

  it('maps a non-ok status to agent_error', () => {
    expect(classifyFailure({ ...base, parsed: { status: 'error' } })).toBe('agent_error');
  });

  it('maps ECONNREFUSED in stderr to runtime_unavailable', () => {
    expect(
      classifyFailure({ ...base, exitCode: 1, parsed: null, stderr: 'connect ECONNREFUSED 127.0.0.1:18789' }),
    ).toBe('runtime_unavailable');
  });

  it('maps exit 127 to runtime_unavailable', () => {
    expect(classifyFailure({ ...base, exitCode: 127, parsed: null })).toBe('runtime_unavailable');
  });

  it('maps other nonzero exits to agent_error', () => {
    expect(classifyFailure({ ...base, exitCode: 7, parsed: null })).toBe('agent_error');
  });
});

describe('OpenClawCliClient subprocess lifecycle', () => {
  it('runs a task: writes the reply to the output file, surfaces the session id, succeeds', async () => {
    const req = await request();
    const response = await client('ok').run(req);

    expect(response.exitCode).toBe(0);
    expect(response.failureKind).toBeUndefined();
    expect(response.sessionId).toBe('fake-session-1');
    expect(response.output.exists).toBe(true);
    expect(response.output.bytes).toBeGreaterThan(50);
    const written = await readFile(req.outputPath, 'utf8');
    expect(written).toContain('fake agent output');
  });

  it('passes the prompt FILE content as --message', async () => {
    const req = await request();
    await import('node:fs/promises').then((fs) => fs.mkdir(join(workdir, 'prompts'), { recursive: true }));
    await writeFile(req.promptPath, 'PROMPT-BODY-MARKER');
    await client('echo_message').run(req);
    const written = await readFile(req.outputPath, 'utf8');
    expect(written).toContain('PROMPT-BODY-MARKER');
  });

  it('passes the runtime-derived --model on the wire (vendor prefix stripped)', async () => {
    const req = await request({ runtime: 'claude-cli', model: 'anthropic/claude-opus-4-7' });
    await client('echo_model').run(req);
    const written = await readFile(req.outputPath, 'utf8');
    expect(written).toBe('MODEL:claude-cli/claude-opus-4-7');
  });

  it('joins multiple payloads into the output file', async () => {
    const req = await request();
    await client('multi').run(req);
    const written = await readFile(req.outputPath, 'utf8');
    expect(written).toBe('first chunk\n\nsecond chunk');
  });

  it('streams stdout/stderr to the request log paths', async () => {
    const req = await request();
    await client('ok').run(req);
    const stdout = await readFile(req.stdoutPath, 'utf8');
    expect(stdout).toContain('"status"');
  });

  it('maps a refusal to agent_error and still writes the refusal text', async () => {
    const req = await request();
    const response = await client('refusal').run(req);
    expect(response.failureKind).toBe('agent_error');
    expect(response.exitCode).toBe(0);
  });

  it('maps a non-ok status to agent_error', async () => {
    const req = await request();
    const response = await client('not_ok').run(req);
    expect(response.failureKind).toBe('agent_error');
  });

  it('maps a generic nonzero exit to agent_error', async () => {
    const req = await request();
    const response = await client('nonzero').run(req);
    expect(response.failureKind).toBe('agent_error');
    expect(response.exitCode).toBe(7);
  });

  it('maps a connection-refused gateway to runtime_unavailable', async () => {
    const req = await request();
    const response = await client('refused_conn').run(req);
    expect(response.failureKind).toBe('runtime_unavailable');
  });

  it('maps a missing binary to runtime_unavailable', async () => {
    const req = await request();
    const c = new OpenClawCliClient({
      config: { bin: '/does/not/exist/openclaw-xyz', baseArgs: ['agent', '--json'], agentId: 'main' },
    });
    const response = await c.run(req);
    expect(response.failureKind).toBe('runtime_unavailable');
  });

  it('enforces the timeout budget and reports timeout', async () => {
    const req = await request({ timeoutMs: 150 });
    const response = await client('hang').run(req);
    expect(response.failureKind).toBe('timeout');
    expect(response.exitCode).toBe(1);
  });

  it('resume threads --session-id and surfaces the runtime session id', async () => {
    const req = await request();
    const response = await client('ok').resume({ ...req, sessionId: 'resumed-session-9' });
    expect(response.sessionId).toBe('resumed-session-9');
    const stdout = await readFile(req.stdoutPath, 'utf8');
    expect(stdout).toContain('resumed-session-9');
  });
});
