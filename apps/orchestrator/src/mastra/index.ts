/**
 * Mastra Studio entry point (#10).
 *
 * `mastra dev` (the Studio dev server, default `http://localhost:4111`)
 * discovers this file (`src/mastra/index.ts`) and reads its exported `mastra`
 * const. We register the stub-backed sample workflow ({@link buildSampleWorkflow})
 * so Studio renders the `full` workflow graph and a complete run trace WITHOUT
 * any real LLM or OpenClaw CLI subprocess.
 *
 * Production-OFF (ADR-015): {@link isStudioEnabled} gates registration. When the
 * `FORGEROOM_STUDIO` opt-in flag is absent (the production default) this entry
 * exports an EMPTY Mastra instance — `mastra dev` would have nothing to show and
 * production start scripts never invoke `mastra dev` at all. The trace store is
 * an in-process store (the same pattern pipeline-engine.ts uses); Studio's dev
 * server reads workflow runs and their step spans from it.
 *
 * This module is dev-only and is excluded from the production build entry
 * surface; it only CONSUMES the #6 adapter via {@link buildSampleWorkflow}.
 */
import { Mastra } from '@mastra/core';
import { InMemoryStore } from '@mastra/core/storage';

import { isStudioEnabled } from '../studio/gate.js';
import { buildSampleWorkflow } from '../studio/sample-workflow.js';
import { SAMPLE_WORKFLOW_ID } from '../studio/sample-config.js';

/**
 * Build the Mastra instance Studio loads. When the gate is off the workflow map
 * is empty, so a production process that loads this entry exposes nothing.
 * Exported (not just the const) so tests can assert the gated behaviour without
 * mutating real `process.env`.
 */
export function buildStudioMastra(enabled: boolean = isStudioEnabled()): Mastra {
  const workflows = enabled
    ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ({ [SAMPLE_WORKFLOW_ID]: buildSampleWorkflow().workflow as any } as Record<string, unknown>)
    : {};

  return new Mastra({
    storage: new InMemoryStore(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    workflows: workflows as any,
    logger: false,
  });
}

/** The instance `mastra dev` reads. Empty unless FORGEROOM_STUDIO opts in. */
export const mastra = buildStudioMastra();
