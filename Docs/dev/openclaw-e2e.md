---
status: living
last_reviewed: 2026-05-24
---

# OpenClaw provider e2e verification (#31, reworked #45)

How to run the real `OpenClawProvider` against an OpenClaw runtime, and what
was verified locally vs what needs a live runtime + credentials.

## What this proves

The real `OpenClawProvider` (core) drives the real `OpenClawCliClient`
subprocess transport (`apps/orchestrator/src/app/openclaw-ipc.ts`) over the real
`openclaw agent --json` contract (#45):

- shallow readiness `health()` (ADR-012),
- prompt-file-in (`.forgeroom/prompts/NN_*.md`) → the adapter reads it and passes
  the content inline as `--message`; the agent returns JSON; the adapter parses
  the reply and WRITES it to the output file (`.forgeroom/outputs/NN_*.md`), and
  surfaces the runtime session id for resume,
- connection-refused gateway → `failureKind: 'runtime_unavailable'`,
- timeout path → `failureKind: 'timeout'`.

## Run it

Gated — NOT part of `pnpm test`:

```sh
pnpm -F orchestrator test:e2e
```

### Default (fake CLI) mode

With no extra env, the harness uses a bundled fake OpenClaw CLI that emits the
real `agent --json` JSON envelope on stdout. It exercises the FULL provider →
subprocess → output-file path (spawn lifecycle, JSON parse, session-id
extraction, the adapter writing the output file, connection-refused + timeout
mapping) without a live runtime. This is what runs in CI/sandbox.

### Live runtime mode — use the standalone smoke script, not `test:e2e`

The real `openclaw` binary is a Node ESM CLI that spawns its own children. When
spawned from a **vitest worker** it emits empty stdio (a harness artifact — the
production plain-node path works fine), so the vitest LIVE real-run is skipped.
Live verification runs in plain node via a standalone script (the same path
`node dist/main.js` uses):

```sh
pnpm -F orchestrator build
FORGEROOM_OPENCLAW_BIN=openclaw \
FORGEROOM_OPENCLAW_ENDPOINT=http://127.0.0.1:18789 \
FORGEROOM_OPENCLAW_TOKEN=<real-token> \
FORGEROOM_OPENCLAW_RUNTIME=claude-cli \
FORGEROOM_OPENCLAW_AGENT=main \
pnpm -F orchestrator smoke:openclaw
```

It runs ONE real agent turn end to end and asserts exit 0 + an output file +
a session id, printing `PASS`/`FAIL`. The connection-refused and timeout paths
stay covered by the fake-CLI `test:e2e`.

## Required env / credentials

| Var | Purpose | Default |
|---|---|---|
| `FORGEROOM_OPENCLAW_E2E_LIVE` | `1` selects the live runtime | unset (fake) |
| `FORGEROOM_OPENCLAW_BIN` | OpenClaw CLI binary | `openclaw` |
| `FORGEROOM_OPENCLAW_ARGS` | JSON string-array leading argv | `["agent","--json"]` |
| `FORGEROOM_OPENCLAW_AGENT` | OpenClaw agent id | `main` |
| `FORGEROOM_OPENCLAW_ENDPOINT` | gateway endpoint (loopback) | `http://127.0.0.1:18789` |
| `FORGEROOM_OPENCLAW_TOKEN` | gateway auth token | — (required for live) |
| `FORGEROOM_OPENCLAW_RUNTIME` | runtime id | `claude-cli` |

The token is passed to the child via the `OPENCLAW_TOKEN` env var, never argv.

## The real `openclaw agent --json` contract (#45)

Verified against OpenClaw 2026.5.18. The adapter builds:

```
<bin> agent --json --agent <agentId> [--session-id <id>] --message <promptText> \
      [--model <provider/model>] [--timeout <seconds>]
```

(`<baseArgs...>` defaults to `agent --json`; override via `FORGEROOM_OPENCLAW_ARGS`.)
There is NO `openclaw exec`. The prompt file (`.forgeroom/prompts/NN_*.md`) is
read by the adapter and its content passed inline as `--message` (the file is
kept for audit; note the OS argv-size caveat for very large prompts). The agent
returns a JSON envelope on stdout — the adapter parses it and writes the reply
to the output file (`.forgeroom/outputs/NN_*.md`); the agent no longer writes a
file.

JSON fields the adapter reads:

- `status === "ok"` → success; otherwise `agent_error`.
- reply text = join of `result.payloads[].text` (blank-line separated), fallback
  `result.meta.finalAssistantVisibleText`.
- resume session id = `result.meta.agentMeta.sessionId` (fallback
  `result.meta.agentMeta.cliSessionBinding.sessionId`).
- `result.meta.completion.refusal === true` → `agent_error`.

Process-level mapping: spawn `ENOENT` / exit `127` → `runtime_unavailable`;
nonzero exit with `ECONNREFUSED` in stderr → `runtime_unavailable`; any other
nonzero → `agent_error`; a SIGTERM-on-timeout (escalating to SIGKILL, plus the
forwarded CLI `--timeout`) → `timeout`. The provider/runner own
`output_contract_failed`; this adapter never sets it (ADR-012).

If your real OpenClaw CLI differs, override `FORGEROOM_OPENCLAW_BIN` /
`FORGEROOM_OPENCLAW_ARGS` / `FORGEROOM_OPENCLAW_AGENT`.

## Verified locally vs needs live runtime

Verified here (no live runtime needed):

- Subprocess spawn/stream/exit lifecycle against a real child process.
- JSON envelope parse: payload joining, `finalAssistantVisibleText` fallback,
  session-id extraction (`agentMeta.sessionId` preferred, `cliSessionBinding`
  fallback), prior-session fallback on resume.
- The adapter writing the reply to `.forgeroom/outputs/NN_*.md` (exists/bytes).
- Error mapping: timeout, refusal / non-ok status → `agent_error`,
  connection-refused → `runtime_unavailable`, missing binary →
  `runtime_unavailable`, nonzero exit → `agent_error` — unit-tested
  (`openclaw-ipc.test.ts`) and via the e2e harness fake path.

Needs a live OpenClaw runtime + credentials (NOT performed in this sandbox):

- A real agent returning a real JSON envelope written to `.forgeroom/outputs/`.
- Confirming the captured field paths still hold on your install version.
- A live timeout against a genuinely slow task and a live connection-refusal.
