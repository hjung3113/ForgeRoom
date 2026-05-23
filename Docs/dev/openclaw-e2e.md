---
status: living
last_reviewed: 2026-05-23
---

# OpenClaw provider e2e verification (#31)

How to run the real `OpenClawProvider` against an OpenClaw runtime, and what
was verified locally vs what needs a live runtime + credentials.

## What this proves

The real `OpenClawProvider` (core) drives the real `OpenClawCliClient`
subprocess transport (`apps/orchestrator/src/app/openclaw-ipc.ts`) through the
[prompt-file protocol](../concepts/prompt-file-protocol.md):

- shallow readiness `health()` (ADR-012),
- session creation + prompt-file-in (`.forgeroom/prompts/NN_*.md`) →
  output-file-out (`.forgeroom/outputs/NN_*.md`),
- auth-failure path → `failureKind: 'auth_failed'`,
- timeout path → `failureKind: 'timeout'`.

## Run it

Gated — NOT part of `pnpm test`:

```sh
pnpm -F orchestrator test:e2e
```

### Default (fake CLI) mode

With no extra env, the harness uses a bundled fake OpenClaw CLI that honours the
adapter's documented argv + marker convention. It exercises the FULL provider →
subprocess → output-file path (spawn lifecycle, session-id parsing, output-file
measurement, auth + timeout mapping) without a live runtime. This is what runs
in CI/sandbox and is what was verified locally.

### Live runtime mode

```sh
FORGEROOM_OPENCLAW_E2E_LIVE=1 \
FORGEROOM_OPENCLAW_BIN=openclaw \
FORGEROOM_OPENCLAW_ENDPOINT=http://127.0.0.1:4317 \
FORGEROOM_OPENCLAW_TOKEN=<real-token> \
FORGEROOM_OPENCLAW_RUNTIME=claude-cli \
pnpm -F orchestrator test:e2e
```

In LIVE mode the auth-failure and timeout assertions are skipped (they need
deliberately-invalid credentials / a deliberately-slow task); run those manually
(see below). The success path runs a real agent task end to end.

## Required env / credentials

| Var | Purpose | Default |
|---|---|---|
| `FORGEROOM_OPENCLAW_E2E_LIVE` | `1` selects the live runtime | unset (fake) |
| `FORGEROOM_OPENCLAW_BIN` | OpenClaw CLI binary | `openclaw` |
| `FORGEROOM_OPENCLAW_ARGS` | JSON string-array leading argv | `["exec"]` |
| `FORGEROOM_OPENCLAW_ENDPOINT` | runtime endpoint (loopback) | `http://127.0.0.1:4317` |
| `FORGEROOM_OPENCLAW_TOKEN` | runtime auth token | — (required for live) |
| `FORGEROOM_OPENCLAW_RUNTIME` | runtime id | `claude-cli` |

The token is passed to the child via the `OPENCLAW_TOKEN` env var, never argv.

## ForgeRoom OpenClaw CLI adapter convention

The exact OpenClaw CLI command line is NOT pinned by the upstream docs, so the
adapter defines a documented convention (overridable via `FORGEROOM_OPENCLAW_BIN`
/ `FORGEROOM_OPENCLAW_ARGS`). The default invocation is:

```
<bin> <baseArgs...> --runtime <runtime> --model <model> --cwd <cwd> \
      --mode <headless|pty> --message "<promptInstruction> <outputInstruction>" \
      [--session <id>]   # resume only
```

Markers the adapter parses from the runtime's output:

- `OPENCLAW_SESSION_ID=<id>` (stdout, strict full-line) → `sessionId`.
- `OPENCLAW_AUTH_FAILED=1` (stdout/stderr) → `auth_failed`.

Exit-code fallbacks: `41` → `auth_failed`, `127` / spawn `ENOENT` →
`runtime_unavailable`, any other nonzero → `agent_error`, `0` → success. A
SIGTERM-on-timeout (escalating to SIGKILL) → `timeout`. The provider/runner own
`output_contract_failed`; this adapter never sets it (ADR-012).

If your real OpenClaw CLI differs, override `FORGEROOM_OPENCLAW_BIN` /
`FORGEROOM_OPENCLAW_ARGS`, or wrap it in a thin shim emitting these markers.

## Verified locally vs needs live runtime

Verified here (no live runtime needed):

- Subprocess spawn/stream/exit lifecycle against a real child process.
- Session-id marker parsing + prior-session fallback.
- Output-file measurement (exists/bytes) from the output instruction.
- Error mapping: timeout, auth (marker + exit 41), `runtime_unavailable`
  (missing binary), `agent_error` — unit-tested (`openclaw-ipc.test.ts`) and
  via the e2e harness fake path.
- Full provider → subprocess → `.forgeroom/outputs/NN_*.md` path.

Needs a live OpenClaw runtime + credentials (NOT performed in this sandbox):

- A real agent producing a real `.forgeroom/outputs/NN_*.md` file.
- Confirming the real CLI's actual argv/markers match (or shimming this
  convention onto it). The argv/marker contract above is the ForgeRoom-side
  expectation, not an upstream OpenClaw guarantee.
- Live auth-failure with truly invalid credentials and a live timeout against a
  genuinely slow task.
