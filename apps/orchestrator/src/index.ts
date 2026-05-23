/**
 * Orchestrator package entry surface (#30).
 *
 * Re-exports the composition root + boot entry. The runnable boot lives in
 * `main.ts` (the `start` script runs it); this module keeps a stable public
 * surface for embedders and tests.
 */
export const version = '0.1.0';

export { bootOrchestrator } from './main.js';
export { composeOrchestrator, type OrchestratorApp } from './app/composition-root.js';
export { loadRegistries, resolveEnv, type OrchestratorEnv } from './app/config.js';
