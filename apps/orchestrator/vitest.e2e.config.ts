import { defineConfig } from 'vitest/config';

/**
 * Gated e2e config (#31). Runs ONLY the OpenClaw provider e2e harness and is
 * NEVER part of the default `pnpm test` (which uses `vitest.config.ts` with the
 * `unit` + `integration` projects). Invoked via `pnpm -F orchestrator test:e2e`.
 *
 * The harness defaults to a bundled fake OpenClaw CLI so it is runnable without
 * a live runtime. Set `FORGEROOM_OPENCLAW_E2E_LIVE=1` (+ real credentials) to
 * drive the actual `openclaw` binary. See `Docs/dev/openclaw-e2e.md`.
 */
export default defineConfig({
  test: {
    name: 'e2e',
    include: ['tests/e2e/**/*.e2e.ts'],
    // A real runtime call can take a while; the fake path is fast.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
