#!/usr/bin/env node
/**
 * Standalone LIVE OpenClaw smoke (#49). Runs ONE real agent turn through the
 * compiled `OpenClawProvider` → real `openclaw agent --json` against the
 * configured gateway, and asserts the production contract: exit 0, an output
 * file written under `.forgeroom/outputs/`, and a session id.
 *
 * Why a script and not a vitest test: `openclaw` is a Node ESM bin that spawns
 * its own children; launched from a vitest worker it emits empty stdio. This
 * plain-node path is exactly what `node dist/main.js` (production) uses, so it
 * is the faithful live verification.
 *
 * Prereq: `pnpm -F orchestrator build` (this imports from `dist/`), a running
 * gateway, and the `FORGEROOM_OPENCLAW_*` env (see Docs/dev/integration-setup.md).
 *
 *   pnpm -F orchestrator build && pnpm -F orchestrator smoke:openclaw
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, '..', 'dist');

const { OpenClawProvider } = await import(join(distDir, 'app', 'openclaw-provider.js'));
const { OpenClawCliClient, resolveOpenClawCliConfig } = await import(
  join(distDir, 'app', 'openclaw-ipc.js')
);

const env = process.env;
const endpoint = env.FORGEROOM_OPENCLAW_ENDPOINT ?? 'http://127.0.0.1:18789';
const token = env.FORGEROOM_OPENCLAW_TOKEN ?? '';
const runtime = env.FORGEROOM_OPENCLAW_RUNTIME ?? 'claude-cli';
const agentId = env.FORGEROOM_OPENCLAW_AGENT ?? 'main';

if (token === '') {
  console.error('FORGEROOM_OPENCLAW_TOKEN is required (the gateway.auth.token from ~/.openclaw/openclaw.json).');
  process.exit(2);
}

const workdir = join(tmpdir(), `openclaw-smoke-${Date.now()}`);
const promptPath = join(workdir, '.forgeroom', 'prompts', '01_smoke.md');
const outputPath = join(workdir, '.forgeroom', 'outputs', '01_smoke.md');
await mkdir(dirname(promptPath), { recursive: true });
await mkdir(dirname(outputPath), { recursive: true });
await mkdir(join(workdir, '.forgeroom', 'logs'), { recursive: true });
await writeFile(
  promptPath,
  'ForgeRoom live smoke. Write a one-line markdown note confirming you ran.\n',
);

const config = resolveOpenClawCliConfig({
  cliBin: env.FORGEROOM_OPENCLAW_BIN,
  cliArgsJson: env.FORGEROOM_OPENCLAW_ARGS,
  agentId,
});
const provider = new OpenClawProvider({
  endpoint,
  token,
  runtime,
  agentId,
  client: new OpenClawCliClient({ config }),
});
const agent = { agentId: 'claude', runtime, model: 'anthropic/claude-opus-4-7', harness: 'implementation' };
const req = {
  agentId: 'claude',
  promptPath,
  outputPath,
  stdoutPath: join(workdir, '.forgeroom', 'logs', '01.stdout.log'),
  stderrPath: join(workdir, '.forgeroom', 'logs', '01.stderr.log'),
  cwd: workdir,
  mode: 'headless',
  timeoutMs: 120_000,
};

console.error(`[smoke] endpoint=${endpoint} agent=${agentId} runtime=${runtime}`);
const result = await provider.run(req, agent);
console.error(`[smoke] result: ${JSON.stringify(result)}`);

let ok = true;
const fail = (msg) => {
  ok = false;
  console.error(`[smoke] FAIL: ${msg}`);
};
if (result.failureKind !== undefined) fail(`failureKind=${result.failureKind}`);
if (result.exitCode !== 0) fail(`exitCode=${result.exitCode}`);
if (!result.outputExists) fail('output file not written');
if ((result.outputBytes ?? 0) <= 50) fail(`output too small (${result.outputBytes} bytes)`);
if (result.sessionId == null) fail('no session id');

if (ok) {
  const text = await readFile(outputPath, 'utf8');
  console.error(`[smoke] output (${result.outputBytes} bytes):\n${text}`);
  console.error('[smoke] PASS — real OpenClaw turn produced an output file + session id.');
}

await rm(workdir, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
