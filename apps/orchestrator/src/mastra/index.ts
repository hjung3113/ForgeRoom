/**
 * Mastra Studio entry point (#10).
 *
 * `mastra dev` (the Studio dev server, default `http://localhost:4111`)
 * discovers this file (`src/mastra/index.ts`) and reads its exported `mastra`
 * const. We register the stub-backed sample workflow ({@link buildSampleWorkflow})
 * so Studio renders the `full` workflow graph and a complete run trace WITHOUT
 * any real LLM or OpenClaw CLI subprocess, plus the read-only ForgeRoom operator
 * tools (Phase 2C) so Studio doubles as an operator console.
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
import { fileURLToPath } from 'node:url';

import { Mastra } from '@mastra/core';
import { InMemoryStore } from '@mastra/core/storage';

import { loadHarnessContracts, loadRegistries, resolveEnv } from '../app/config.js';
import { createTaskStoreDatabase, migrateTaskStoreDatabase } from '../db/client.js';
import { SqliteTaskStore } from '../db/sqlite-task-store.js';
import { isStudioEnabled } from '../studio/gate.js';
import { buildSampleWorkflow } from '../studio/sample-workflow.js';
import { SAMPLE_WORKFLOW_ID } from '../studio/sample-config.js';
import { buildForgeRoomTools, type ForgeRoomToolDeps } from './tools/forgeroom-tools.js';

/**
 * Build the Mastra instance Studio loads. When the gate is off the workflow map
 * is empty, so a production process that loads this entry exposes nothing.
 * Exported (not just the const) so tests can assert the gated behaviour without
 * mutating real `process.env`. `toolDeps` registers the read-only ForgeRoom
 * operator tools (Phase 2C); omitted (or gate off) → no tools.
 */
export function buildStudioMastra(
  enabled: boolean = isStudioEnabled(),
  toolDeps?: ForgeRoomToolDeps,
): Mastra {
  const workflows = enabled
    ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ({ [SAMPLE_WORKFLOW_ID]: buildSampleWorkflow().workflow as any } as Record<string, unknown>)
    : {};

  const tools = enabled && toolDeps !== undefined ? buildForgeRoomTools(toolDeps) : {};

  return new Mastra({
    storage: new InMemoryStore(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    workflows: workflows as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: tools as any,
    logger: false,
  });
}

/**
 * Build the read-only tool deps (project registry + task store) from the live
 * config + DB. Dev-only; returns null on any failure so a misconfigured Studio
 * session still loads (workflows only, no tools) instead of crashing.
 */
export async function buildStudioToolDeps(): Promise<ForgeRoomToolDeps | null> {
  try {
    const configDir = fileURLToPath(new URL('../../../configs', import.meta.url));
    const registries = await loadRegistries({ configDir });
    const env = resolveEnv();
    const database = createTaskStoreDatabase(env.dbPath);
    migrateTaskStoreDatabase(database);
    const taskStore = new SqliteTaskStore(database);
    const { manifests: harnessManifests } = await loadHarnessContracts(env.harnessRoot, registries.harnesses);
    return { projects: registries.projects, taskStore, harnessManifests };
  } catch {
    return null;
  }
}

/** The instance `mastra dev` reads. Empty unless FORGEROOM_STUDIO opts in. */
export const mastra = isStudioEnabled()
  ? buildStudioMastra(true, (await buildStudioToolDeps()) ?? undefined)
  : buildStudioMastra(false);
