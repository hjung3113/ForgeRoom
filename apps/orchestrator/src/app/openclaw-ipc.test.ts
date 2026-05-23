import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { OpenClawExecutionRequest } from '../core/openclaw-provider.js';
import {
  OpenClawCliClient,
  OpenClawCliConfigError,
  classifyFailure,
  parseOutputPath,
  resolveOpenClawCliConfig,
} from './openclaw-ipc.js';

// A fake OpenClaw CLI: a node script driven by FAKE_OPENCLAW_MODE. It honours
// the adapter's documented argv/markers so the subprocess lifecycle, session
// parsing, output-file measurement, and error mapping are exercised end to end
// against a real child process (no live OpenClaw runtime needed).
const FAKE_CLI = `
const fs = require('node:fs');
const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }
const mode = process.env.FAKE_OPENCLAW_MODE || 'ok';
const message = arg('--message') || '';
const m = /Write your response to (.+?)\\.?$/.exec(message.trim());
const session = arg('--session') || 'fake-session-1';
if (mode === 'ok') {
  process.stdout.write('OPENCLAW_SESSION_ID=' + session + '\\n');
  if (m) { fs.mkdirSync(require('node:path').dirname(m[1]), { recursive: true }); fs.writeFileSync(m[1], 'fake agent output that is well over fifty bytes long for the runner.'); }
  process.exit(0);
} else if (mode === 'auth') {
  process.stdout.write('OPENCLAW_SESSION_ID=' + session + '\\n');
  process.stderr.write('OPENCLAW_AUTH_FAILED=1\\n');
  process.exit(41);
} else if (mode === 'agent_error') {
  process.stdout.write('OPENCLAW_SESSION_ID=' + session + '\\n');
  process.stderr.write('boom\\n');
  process.exit(7);
} else if (mode === 'hang') {
  setTimeout(() => process.exit(0), 60000);
}
`;

let workdir: string;
let cliPath: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'openclaw-ipc-'));
  cliPath = join(workdir, 'fake-openclaw.cjs');
  await import('node:fs/promises').then((fs) => fs.writeFile(cliPath, FAKE_CLI));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

function request(overrides: Partial<OpenClawExecutionRequest> = {}): OpenClawExecutionRequest {
  const outputPath = join(workdir, 'outputs', '01_plan.md');
  return {
    endpoint: 'http://127.0.0.1:4317',
    token: 'tok',
    runtime: 'claude-cli',
    model: 'anthropic/claude-opus-4-7',
    cwd: workdir,
    mode: 'headless',
    promptInstruction: `Read ${join(workdir, 'prompts', '01_plan.md')}. Follow the instructions inside.`,
    outputInstruction: `Write your response to ${outputPath}.`,
    stdoutPath: join(workdir, 'logs', '01.stdout.log'),
    stderrPath: join(workdir, 'logs', '01.stderr.log'),
    timeoutMs: 5_000,
    ...overrides,
  };
}

function client(mode: string): OpenClawCliClient {
  return new OpenClawCliClient({
    config: { bin: process.execPath, baseArgs: [cliPath], extraEnv: { FAKE_OPENCLAW_MODE: mode } },
  });
}

describe('resolveOpenClawCliConfig', () => {
  it('defaults bin to openclaw and base args to exec', () => {
    expect(resolveOpenClawCliConfig({})).toEqual({ bin: 'openclaw', baseArgs: ['exec'] });
  });

  it('honours overrides', () => {
    expect(resolveOpenClawCliConfig({ cliBin: 'oc', cliArgsJson: '["run","--json"]' })).toEqual({
      bin: 'oc',
      baseArgs: ['run', '--json'],
    });
  });

  it('rejects non-array JSON', () => {
    expect(() => resolveOpenClawCliConfig({ cliArgsJson: '{"a":1}' })).toThrow(OpenClawCliConfigError);
  });

  it('rejects malformed JSON', () => {
    expect(() => resolveOpenClawCliConfig({ cliArgsJson: 'not json' })).toThrow(OpenClawCliConfigError);
  });
});

describe('parseOutputPath', () => {
  it('extracts the output path from the instruction', () => {
    expect(parseOutputPath('Write your response to /a/b/01_plan.md.')).toBe('/a/b/01_plan.md');
  });

  it('returns null for an unrecognised instruction', () => {
    expect(parseOutputPath('do something else')).toBeNull();
  });
});

describe('classifyFailure', () => {
  const base = { timedOut: false, spawnError: null, exitCode: 0, stdout: '', stderr: '' };

  it('maps a clean exit to no failure', () => {
    expect(classifyFailure(base)).toBeUndefined();
  });

  it('maps a timeout', () => {
    expect(classifyFailure({ ...base, timedOut: true })).toBe('timeout');
  });

  it('maps ENOENT spawn errors to runtime_unavailable', () => {
    const err = Object.assign(new Error('nope'), { code: 'ENOENT' });
    expect(classifyFailure({ ...base, spawnError: err })).toBe('runtime_unavailable');
  });

  it('maps the auth marker to auth_failed', () => {
    expect(classifyFailure({ ...base, exitCode: 1, stderr: 'OPENCLAW_AUTH_FAILED=1\n' })).toBe('auth_failed');
  });

  it('maps exit 41 to auth_failed', () => {
    expect(classifyFailure({ ...base, exitCode: 41 })).toBe('auth_failed');
  });

  it('maps exit 127 to runtime_unavailable', () => {
    expect(classifyFailure({ ...base, exitCode: 127 })).toBe('runtime_unavailable');
  });

  it('maps other nonzero exits to agent_error', () => {
    expect(classifyFailure({ ...base, exitCode: 7 })).toBe('agent_error');
  });
});

describe('OpenClawCliClient subprocess lifecycle', () => {
  it('runs a task: writes the output file, parses the session id, succeeds', async () => {
    const response = await client('ok').run(request());

    expect(response.exitCode).toBe(0);
    expect(response.failureKind).toBeUndefined();
    expect(response.sessionId).toBe('fake-session-1');
    expect(response.output.exists).toBe(true);
    expect(response.output.bytes).toBeGreaterThan(50);
    const written = await readFile(join(workdir, 'outputs', '01_plan.md'), 'utf8');
    expect(written).toContain('fake agent output');
  });

  it('streams stdout/stderr to the request log paths', async () => {
    await client('ok').run(request());
    const stdout = await readFile(join(workdir, 'logs', '01.stdout.log'), 'utf8');
    expect(stdout).toContain('OPENCLAW_SESSION_ID=');
  });

  it('maps an auth failure to auth_failed and no output', async () => {
    const response = await client('auth').run(request());
    expect(response.failureKind).toBe('auth_failed');
    expect(response.exitCode).toBe(41);
    expect(response.output.exists).toBe(false);
  });

  it('maps a generic nonzero exit to agent_error', async () => {
    const response = await client('agent_error').run(request());
    expect(response.failureKind).toBe('agent_error');
    expect(response.exitCode).toBe(7);
  });

  it('maps a missing binary to runtime_unavailable', async () => {
    const c = new OpenClawCliClient({ config: { bin: '/does/not/exist/openclaw-xyz', baseArgs: [] } });
    const response = await c.run(request());
    expect(response.failureKind).toBe('runtime_unavailable');
  });

  it('enforces the timeout budget and reports timeout', async () => {
    const response = await client('hang').run(request({ timeoutMs: 150 }));
    expect(response.failureKind).toBe('timeout');
    expect(response.exitCode).toBe(1);
  });

  it('resume threads --session and parses the runtime-echoed session id', async () => {
    const response = await client('ok').resume({ ...request(), sessionId: 'resumed-session-9' });
    expect(response.sessionId).toBe('resumed-session-9');
    const stdout = await readFile(join(workdir, 'logs', '01.stdout.log'), 'utf8');
    expect(stdout).toContain('OPENCLAW_SESSION_ID=resumed-session-9');
  });

  it('falls back to the prior session id when the runtime emits no marker', async () => {
    // agent_error mode still emits a marker; use a fresh client whose CLI omits
    // the marker by overriding the message so no output marker is parseable.
    const c = new OpenClawCliClient({
      config: { bin: process.execPath, baseArgs: ['-e', 'process.exit(0)'] },
    });
    const response = await c.resume({ ...request(), sessionId: 'kept-session' });
    expect(response.sessionId).toBe('kept-session');
  });
});
