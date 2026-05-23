/**
 * Real OpenClawProvider end-to-end verification harness (#31).
 *
 * GATED: this file is NOT part of the default `pnpm test`. It runs only via
 * `pnpm -F orchestrator test:e2e` (see `vitest.e2e.config.ts`).
 *
 * It drives the REAL `OpenClawProvider` (core) over the REAL `OpenClawCliClient`
 * subprocess transport (app), through the file-based prompt protocol, proving:
 *   - readiness/health (shallow, ADR-012),
 *   - session creation + prompt-file-in → output-file-out under `.forgeroom/`,
 *   - the auth-failure path surfaces `failureKind: 'auth_failed'`,
 *   - the timeout path surfaces `failureKind: 'timeout'`.
 *
 * Two execution modes:
 *   - DEFAULT (fake): uses a bundled fake OpenClaw CLI honouring the adapter's
 *     documented argv/markers, so the FULL path is exercised without a live
 *     runtime or credentials. This is what runs here in the sandbox.
 *   - LIVE: set `FORGEROOM_OPENCLAW_E2E_LIVE=1` plus real credentials
 *     (`FORGEROOM_OPENCLAW_BIN`, `FORGEROOM_OPENCLAW_ENDPOINT`,
 *     `FORGEROOM_OPENCLAW_TOKEN`, `FORGEROOM_OPENCLAW_RUNTIME`) to drive the
 *     actual `openclaw` binary against a real runtime. See
 *     `Docs/dev/openclaw-e2e.md`.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentRunRequest } from '../../src/core/agent-runner.js';
import type { ResolvedAgent } from '../../src/core/agent-registry.js';
import { OpenClawProvider } from '../../src/core/openclaw-provider.js';
import { OpenClawCliClient, resolveOpenClawCliConfig } from '../../src/app/openclaw-ipc.js';

const LIVE = process.env.FORGEROOM_OPENCLAW_E2E_LIVE === '1';

const FAKE_CLI = `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }
const mode = process.env.FAKE_OPENCLAW_MODE || 'ok';
const message = arg('--message') || '';
const m = /Write your response to (.+?)\\.?$/.exec(message.trim());
const session = arg('--session') || ('sess-' + Date.now());
if (mode === 'auth') {
  process.stderr.write('OPENCLAW_AUTH_FAILED=1\\n');
  process.exit(41);
}
if (mode === 'hang') { setTimeout(() => process.exit(0), 60000); return; }
process.stdout.write('OPENCLAW_SESSION_ID=' + session + '\\n');
if (m) {
  fs.mkdirSync(path.dirname(m[1]), { recursive: true });
  fs.writeFileSync(m[1], '# E2E output\\n\\nThis response was produced by the OpenClaw provider e2e harness and is well over fifty bytes.\\n');
}
process.exit(0);
`;

const agent: ResolvedAgent = {
  agentId: 'claude',
  provider: 'openclaw',
  runtime: process.env.FORGEROOM_OPENCLAW_RUNTIME ?? 'claude-cli',
  model: 'anthropic/claude-opus-4-7',
  harness: 'implementation',
};

let workdir: string;
let cliPath: string;

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'openclaw-e2e-'));
  await mkdir(join(workdir, '.forgeroom', 'prompts'), { recursive: true });
  await mkdir(join(workdir, '.forgeroom', 'logs'), { recursive: true });
  cliPath = join(workdir, 'fake-openclaw.cjs');
  await writeFile(cliPath, FAKE_CLI);
});

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

function provider(mode: string): OpenClawProvider {
  const config = LIVE
    ? resolveOpenClawCliConfig({
        cliBin: process.env.FORGEROOM_OPENCLAW_BIN,
        cliArgsJson: process.env.FORGEROOM_OPENCLAW_ARGS,
      })
    : { bin: process.execPath, baseArgs: [cliPath], extraEnv: { FAKE_OPENCLAW_MODE: mode } };
  return new OpenClawProvider({
    endpoint: process.env.FORGEROOM_OPENCLAW_ENDPOINT ?? 'http://127.0.0.1:4317',
    token: process.env.FORGEROOM_OPENCLAW_TOKEN ?? 'e2e-token',
    runtime: agent.runtime,
    client: new OpenClawCliClient({ config }),
  });
}

async function runRequest(stepIndex: string): Promise<AgentRunRequest> {
  const promptPath = join(workdir, '.forgeroom', 'prompts', `${stepIndex}_e2e.md`);
  const outputPath = join(workdir, '.forgeroom', 'outputs', `${stepIndex}_e2e.md`);
  await writeFile(
    promptPath,
    'You are running a ForgeRoom e2e verification. Write a short markdown note confirming you ran.\n',
  );
  return {
    agentId: 'claude',
    promptPath,
    outputPath,
    stdoutPath: join(workdir, '.forgeroom', 'logs', `${stepIndex}.stdout.log`),
    stderrPath: join(workdir, '.forgeroom', 'logs', `${stepIndex}.stderr.log`),
    cwd: workdir,
    mode: 'headless',
    timeoutMs: LIVE ? 120_000 : 5_000,
  };
}

describe(`OpenClawProvider e2e (${LIVE ? 'LIVE runtime' : 'fake CLI'})`, () => {
  it('reports readiness through a shallow health check', async () => {
    const health = await provider('ok').health();
    expect(health.ok).toBe(true);
  });

  it('runs a real task: prompt-file-in -> output-file-out under .forgeroom/, with a session id', async () => {
    const req = await runRequest('01');
    const result = await provider('ok').run(req, agent);

    expect(result.failureKind).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(result.outputExists).toBe(true);
    expect(result.outputBytes).toBeGreaterThan(50);
    expect(result.sessionId).not.toBeNull();

    const output = await readFile(req.outputPath, 'utf8');
    expect(output.length).toBeGreaterThan(50);
  });

  it('surfaces the auth-failure path as failureKind: auth_failed (ADR-012)', async () => {
    if (LIVE) {
      // A live auth-failure requires deliberately invalid credentials; document
      // the manual step rather than corrupting the live session here.
      return;
    }
    const req = await runRequest('02');
    const result = await provider('auth').run(req, agent);
    expect(result.failureKind).toBe('auth_failed');
    expect(result.outputExists).toBe(false);
  });

  it('surfaces the timeout path as failureKind: timeout (ADR-012)', async () => {
    if (LIVE) {
      // A live timeout needs a task that outlasts the budget; drive it manually
      // with a tiny FORGEROOM step timeout against a long real task instead.
      return;
    }
    const req = await runRequest('03');
    req.timeoutMs = 200;
    const result = await provider('hang').run(req, agent);
    expect(result.failureKind).toBe('timeout');
  });
});
