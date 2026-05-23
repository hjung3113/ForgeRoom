import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type Database from 'better-sqlite3';

const MIGRATION_TABLE = 'forgeroom_migrations';

/**
 * Applies every `*.sql` file under `migrations/` (lexicographic order) exactly
 * once, tracking applied names in `forgeroom_migrations`. Hand-written SQL is
 * used instead of drizzle-kit generated journals so the boot path and the
 * `db:migrate` CLI share one deterministic runner. Down migrations are not
 * supported in Phase 1 (see Docs/concepts/data-model.md).
 */
export function runMigrations(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const applyMigration = sqlite.transaction((name: string, migrationSql: string) => {
    const alreadyApplied = sqlite
      .prepare(`SELECT 1 FROM ${MIGRATION_TABLE} WHERE name = ?`)
      .get(name);
    if (alreadyApplied !== undefined) {
      return;
    }

    sqlite.exec(migrationSql);
    sqlite
      .prepare(`INSERT INTO ${MIGRATION_TABLE} (name, applied_at) VALUES (?, ?)`)
      .run(name, Date.now());
  });

  for (const migration of listMigrations()) {
    applyMigration(migration.name, migration.sql);
  }
}

function listMigrations(): Array<{ name: string; sql: string }> {
  return fs
    .readdirSync(resolveMigrationsPath())
    .filter((entry) => entry.endsWith('.sql'))
    .sort()
    .map((name) => ({
      name,
      sql: fs.readFileSync(path.join(resolveMigrationsPath(), name), 'utf8'),
    }));
}

/**
 * Resolves the directory holding migration SQL. `*.sql` files are not emitted
 * into `dist/` by tsc, so when this module runs from `dist/db/` we fall back to
 * the sibling `src/db/migrations` source-of-truth directory.
 */
function resolveMigrationsPath(): string {
  const adjacent = fileURLToPath(new URL('./migrations', import.meta.url));
  if (fs.existsSync(adjacent)) {
    return adjacent;
  }
  const fromSource = fileURLToPath(new URL('../../src/db/migrations', import.meta.url));
  if (fs.existsSync(fromSource)) {
    return fromSource;
  }
  return adjacent;
}

async function main(): Promise<void> {
  const filename = process.env.FORGEROOM_DB_PATH ?? 'data/forgeroom.sqlite';
  const dir = path.dirname(filename);
  if (filename !== ':memory:' && dir !== '' && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const { createTaskStoreDatabase } = await import('./client.js');
  const database = createTaskStoreDatabase(filename);
  try {
    runMigrations(database.sqlite);
    process.stdout.write(`migrations applied to ${filename}\n`);
  } finally {
    database.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
