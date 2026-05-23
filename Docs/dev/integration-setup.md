---
status: living
last_reviewed: 2026-05-24
---

# Live integration setup (OpenClaw + Discord + GitHub)

How to take the merged Phase 1 MVP from "passes 320 tests with fakes" to "runs a
real task end to end". Everything ForgeRoom needs is configured through
environment variables (read in exactly one place: `apps/orchestrator/src/app/config.ts`)
plus two config files (`configs/projects.yaml`, `configs/discord.yaml`).

> The **ForgeRoom side** below (env var names, config shapes, commands) is
> authoritative — taken from the code. The **OpenClaw side** depends on which
> OpenClaw distribution you run; map your install's actual CLI/endpoint onto the
> `FORGEROOM_OPENCLAW_*` vars (they are all overridable). Confirm against the
> official OpenClaw docs.

---

## 0. Prerequisites

- Node.js >= 22.13 (ADR-018), pnpm 11+.
- `pnpm install` at the repo root succeeds.
- A clean checkout of `main` (Phase 1 MVP merged).

---

## 1. OpenClaw runtime (the agent backend)

ForgeRoom does not run the LLM itself — it shells out to an **OpenClaw** runtime
through a CLI subprocess (`apps/orchestrator/src/app/openclaw-ipc.ts`,
`OpenClawCliClient`). ForgeRoom expects, by convention (all overridable):

| ForgeRoom env | Meaning | Default |
|---|---|---|
| `FORGEROOM_OPENCLAW_BIN` | the OpenClaw CLI binary on PATH | `openclaw` |
| `FORGEROOM_OPENCLAW_ARGS` | JSON array of leading argv | `["exec"]` |
| `FORGEROOM_OPENCLAW_ENDPOINT` | runtime HTTP endpoint (loopback) | `http://127.0.0.1:4317` |
| `FORGEROOM_OPENCLAW_TOKEN` | runtime auth token (passed to the child as `OPENCLAW_TOKEN`, never on argv) | — (required) |
| `FORGEROOM_OPENCLAW_RUNTIME` | runtime/model id | `claude-cli` |

### What you do

1. **Install OpenClaw** per its official docs and run its first-time setup
   (the docs reference `openclaw setup`, which creates `~/.openclaw/openclaw.json`
   and initializes the agent workspace). Confirm:
   - `openclaw` is on your `PATH` (or note the absolute path for `FORGEROOM_OPENCLAW_BIN`).
   - The gateway/runtime server starts and listens on a known host:port (ForgeRoom
     defaults to `http://127.0.0.1:4317` — set `FORGEROOM_OPENCLAW_ENDPOINT` to whatever yours uses).
   - You have an auth token for it → `FORGEROOM_OPENCLAW_TOKEN`.
   - The model/runtime you want (e.g. a Claude CLI runtime) is configured and note
     its id → `FORGEROOM_OPENCLAW_RUNTIME` (default `claude-cli`).
2. **Verify the exact run command.** ForgeRoom assumes `openclaw exec <flags>` reads
   a prompt file and writes an output file (the
   [prompt-file protocol](../concepts/prompt-file-protocol.md)). If your OpenClaw's
   CLI differs, override `FORGEROOM_OPENCLAW_ARGS` (e.g. `["run"]`) and, if the
   verb/marker convention doesn't match, the adapter in `openclaw-ipc.ts` is the one
   place to adjust (this contract is a documented ForgeRoom convention, **not** an
   upstream guarantee — see [openclaw-e2e.md](openclaw-e2e.md)).
3. **Smoke-test the provider** (fake CLI first, then live):
   ```sh
   # fake CLI — proves the wiring without a live runtime
   pnpm -F orchestrator test:e2e

   # live runtime
   FORGEROOM_OPENCLAW_E2E_LIVE=1 \
   FORGEROOM_OPENCLAW_BIN=openclaw \
   FORGEROOM_OPENCLAW_ENDPOINT=http://127.0.0.1:4317 \
   FORGEROOM_OPENCLAW_TOKEN=<your-token> \
   FORGEROOM_OPENCLAW_RUNTIME=claude-cli \
   pnpm -F orchestrator test:e2e
   ```
   If the live success path produces a `.forgeroom/outputs/NN_*.md` file, the
   OpenClaw side is good. If it errors, the most likely fix is `FORGEROOM_OPENCLAW_ARGS`
   or the endpoint/token.

---

## 2. Discord bot

ForgeRoom registers **guild** slash commands (`/run /pause /resume /cancel /status
/ask /feedback`) and uses one bot to both receive commands and post status updates.
Code: `apps/orchestrator/src/gateway/discord-gateway.ts` — it only requests the
`Guilds` gateway intent (no privileged intents needed).

### Create the application + bot

1. Go to the **Discord Developer Portal** → **New Application**. Name it (e.g. "ForgeRoom").
2. Copy the **Application ID** (General Information) → this is `DISCORD_APPLICATION_ID`.
3. **Bot** tab → **Add Bot**. **Reset Token** → copy it → `DISCORD_BOT_TOKEN`.
   - Privileged Gateway Intents: **none required** (ForgeRoom uses only the
     non-privileged `Guilds` intent). You can leave "Message Content", "Presence",
     "Server Members" **off**.
4. **Invite the bot to your server (OAuth2 → URL Generator):**
   - Scopes: **`bot`** and **`applications.commands`** (the second is required for slash commands).
   - Bot Permissions: **Send Messages**, **Embed Links**, **Read Message History**
     (enough to post + edit the per-task status surface and reply to commands).
     Add **Use Slash Commands** if shown.
   - Open the generated URL, pick your server, authorize.
5. **Get your server (guild) ID** and **your own user ID**: enable Developer Mode
   in Discord (Settings → Advanced), right-click the server → Copy Server ID, and
   right-click your name → Copy User ID.

### Env

| Env | Value |
|---|---|
| `DISCORD_BOT_TOKEN` | the bot token from step 3 |
| `DISCORD_APPLICATION_ID` | the application id from step 2 |
| `DISCORD_GUILD_IDS` | comma-separated server ids the bot registers commands in (guild commands appear instantly; global ones take ~1h, so use guild ids for testing) |
| `DISCORD_ALLOWED_USER_IDS` | comma-separated Discord user ids allowed to issue commands — **put your own user id here**, otherwise every command is rejected |

> If `DISCORD_BOT_TOKEN` or `DISCORD_APPLICATION_ID` is empty, the Discord
> TaskSource is simply skipped at boot (no crash).

### Also fill `configs/projects.yaml`

The per-project maintainer allowlist (used for dirty-baseline approval) is separate
from the gateway allowlist. Add your Discord user id under the project:
```yaml
forgeroom:
  maintainers:
    discord_user_ids:
      - "<your-discord-user-id>"
```
`configs/discord.yaml` is currently empty — leave it unless you add channel-routing
overrides later.

---

## 3. GitHub

ForgeRoom polls registered repos for an Issue label → creates a task, and (per
**ADR-019**) creates the PR as a PipelineEngine external effect. Code:
`apps/orchestrator/src/gateway/github-gateway.ts`.

### Token

Create a token that can read issues and write PRs on your project repos:

- **Fine-grained PAT** (recommended): grant the specific repos these repository
  permissions — **Issues: Read**, **Pull requests: Read and write**,
  **Contents: Read and write** (PR creation pushes/branches), **Metadata: Read**.
- Or a **classic PAT** with the `repo` scope.
- Set it as `GITHUB_TOKEN`.

### Repo registration

| Env | Form |
|---|---|
| `FORGEROOM_GITHUB_REPOS` | `projectId=owner/repo[:label],projectId2=owner2/repo2` |

- `projectId` must match a key in `configs/projects.yaml` (e.g. `forgeroom`).
- `:label` is the trigger Issue label; omit to use the gateway default. Example:
  `forgeroom=hjung3113/ForgeRoom:ready-for-agent`.
- Create that label in the repo (Issues → Labels) and apply it to an issue to
  trigger a run.

> If `GITHUB_TOKEN` is empty or `FORGEROOM_GITHUB_REPOS` has no valid entry, the
> GitHub TaskSource is skipped at boot.

---

## 4. Core ForgeRoom env (always required)

| Env | Meaning | Default |
|---|---|---|
| `FORGEROOM_WORKTREE_ROOTS` | **required** — comma-separated absolute paths under which task worktrees may be created | — |
| `FORGEROOM_DB_PATH` | SQLite path | `data/forgeroom.sqlite` |
| `FORGEROOM_SNAPSHOT_DIR` | Mastra snapshot dir | `<db dir>/snapshots` |
| `FORGEROOM_STUDIO` | Studio opt-in — **leave UNSET in production**; boot refuses to start if set (ADR-015) | unset |

---

## 5. Putting it together

> **Note on `.env`:** ForgeRoom has no dotenv loader — `config.ts` reads
> `process.env` directly. So either `export` the vars in your shell, or (cleaner on
> Node 22) keep them in a file and pass `--env-file` to node, as shown in step 3.

1. Create an `.env` (do NOT commit it — it's gitignored) with the vars from §1–4. Minimal example:
   ```sh
   FORGEROOM_WORKTREE_ROOTS=/Users/hyojung/forgeroom-worktrees
   FORGEROOM_OPENCLAW_ENDPOINT=http://127.0.0.1:4317
   FORGEROOM_OPENCLAW_TOKEN=...
   FORGEROOM_OPENCLAW_RUNTIME=claude-cli
   DISCORD_BOT_TOKEN=...
   DISCORD_APPLICATION_ID=...
   DISCORD_GUILD_IDS=...
   DISCORD_ALLOWED_USER_IDS=<your-user-id>
   GITHUB_TOKEN=...
   FORGEROOM_GITHUB_REPOS=forgeroom=hjung3113/ForgeRoom:ready-for-agent
   ```
2. Run the DB migration once: `pnpm -F orchestrator db:migrate` (uses
   `FORGEROOM_DB_PATH` if exported, else the `data/forgeroom.sqlite` default —
   keep it consistent with what `start` will use).
3. Build, then start the orchestrator (`start` runs the compiled `dist/main.js`).
   Because there's no dotenv loader, pass the env file to node directly:
   ```sh
   pnpm -F orchestrator build
   cd apps/orchestrator && node --env-file=../../.env dist/main.js
   ```
   (`pnpm -F orchestrator start` works too, but only if the vars are already
   `export`ed in your shell — it does not read `.env`.)
   (loads configs, wires everything, runs `recoverPending()`, starts the Discord +
   GitHub TaskSources). Studio is NOT started.
4. **Verify each surface:**
   - **Discord:** in your server, run `/status` (should respond), then `/run`
     selecting the `forgeroom` project + a workflow (`quick`/`full`/`hotfix`). Watch
     the status surface update per step.
   - **GitHub:** apply the trigger label to an issue in the registered repo → a task
     should start; on success a PR should be created (ADR-019 discovery-before-create,
     so re-runs reuse the PR rather than duplicating it).
   - **OpenClaw:** confirm a real agent output file appears under the task worktree's
     `.forgeroom/outputs/`.

---

## 6. If something fails — likely culprits

- **Discord commands don't appear:** bot wasn't invited with `applications.commands`
  scope, or the wrong `DISCORD_GUILD_IDS`. Re-invite with the correct scope.
- **Every Discord command rejected:** your user id isn't in `DISCORD_ALLOWED_USER_IDS`.
- **OpenClaw run fails immediately:** wrong `FORGEROOM_OPENCLAW_ARGS` verb, endpoint,
  or token. Try the fake-CLI `test:e2e` first to isolate ForgeRoom-side wiring.
- **GitHub PR not created / task fails with `pr_create_failed`:** token lacks Pull
  requests: write (or `repo` scope), or the branch couldn't be pushed.
- **Approved dirty baseline still blocks:** that was a wiring gap (issue #42); confirm
  you're on a `main` that includes the #42 fix.

## References

- `apps/orchestrator/src/app/config.ts` (the single env-reading place)
- [openclaw-e2e.md](openclaw-e2e.md) (OpenClaw CLI convention + e2e harness)
- ADR-012 (AgentRuntimeProvider boundary), ADR-013 (TaskSource/Reporter), ADR-015
  (Studio off in prod), ADR-019 (PR creation external effect)
- `Docs/modules/discord-gateway.md`, `Docs/modules/github-gateway.md`
