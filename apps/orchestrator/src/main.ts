/**
 * Orchestrator production entry (#30).
 *
 * Loads `configs/*.yaml` + the runtime env (the only place this happens),
 * opens the SQLite TaskStore, composes every module via {@link composeOrchestrator},
 * and runs the boot lifecycle: `recoverPending()` then start the TaskSources.
 *
 * Studio is NOT launched here (ADR-015). `mastra dev` is the separate
 * `dev:studio` script; the production start path never invokes it. If the
 * Studio opt-in flag is set in a production start we refuse to boot rather than
 * silently expose it.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createTaskStoreDatabase, migrateTaskStoreDatabase } from './db/client.js';
import { SqliteTaskStore } from './db/sqlite-task-store.js';
import { composeOrchestrator } from './app/composition-root.js';
import { loadHarnessContracts, loadRegistries, resolveEnv, type OrchestratorEnv } from './app/config.js';

/** Default config dir: `<repo-root>/configs` (three levels up from src/). */
function defaultConfigDir(): string {
  return fileURLToPath(new URL('../../../configs', import.meta.url));
}

export async function bootOrchestrator(input?: {
  configDir?: string;
  env?: OrchestratorEnv;
  log?: (line: string) => void;
}): Promise<{ stop: () => Promise<void> }> {
  const log = input?.log ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const env = input?.env ?? resolveEnv();

  if (env.studioEnabled) {
    throw new Error('FORGEROOM_STUDIO is set in a production start; Studio must be launched via the dev:studio script only');
  }

  const configDir = input?.configDir ?? defaultConfigDir();
  const registries = await loadRegistries({
    configDir,
    templateExists: (relativePath): boolean => existsSync(path.join(env.templateRoot, relativePath)),
  });

  const harnessContracts = await loadHarnessContracts(env.harnessRoot, registries.harnesses);

  const database = createTaskStoreDatabase(env.dbPath);
  migrateTaskStoreDatabase(database);
  const taskStore = new SqliteTaskStore(database);

  const app = composeOrchestrator({ registries, env, taskStore, harnessContracts, log });
  await app.boot();
  log('orchestrator booted: recoverPending complete, TaskSources started');

  return {
    stop: async (): Promise<void> => {
      await app.stop();
      database.close();
    },
  };
}

async function main(): Promise<void> {
  const handle = await bootOrchestrator();
  const shutdown = (): void => {
    void handle.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
