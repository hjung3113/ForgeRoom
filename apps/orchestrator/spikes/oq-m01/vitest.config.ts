/**
 * Isolated vitest config for the OQ-M01 spike.
 *
 * Kept separate from the orchestrator's main `vitest.config.ts` so spike tests
 * never join the `unit`/`integration` projects or the main gate, while still
 * being runnable on demand:
 *   pnpm -F orchestrator exec vitest run -c spikes/oq-m01/vitest.config.ts
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['*.test.ts'],
    root: __dirname,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
