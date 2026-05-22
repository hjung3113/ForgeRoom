import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type Database from 'better-sqlite3';

const MIGRATION_TABLE = 'forgeroom_migrations';

export function runMigrations(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const applyMigration = sqlite.transaction((name: string, sql: string) => {
    const alreadyApplied = sqlite
      .prepare(`SELECT 1 FROM ${MIGRATION_TABLE} WHERE name = ?`)
      .get(name);
    if (alreadyApplied !== undefined) {
      return;
    }

    sqlite.exec(sql);
    sqlite
      .prepare(`INSERT INTO ${MIGRATION_TABLE} (name, applied_at) VALUES (?, ?)`)
      .run(name, Date.now());
  });

  for (const migration of listMigrations()) {
    applyMigration(migration.name, migration.sql);
  }
}

function listMigrations(): Array<{ name: string; sql: string }> {
  const migrationsPath = fileURLToPath(new URL('./migrations', import.meta.url));
  return fs
    .readdirSync(migrationsPath)
    .filter((entry) => entry.endsWith('.sql'))
    .sort()
    .map((name) => ({
      name,
      sql: fs.readFileSync(path.join(migrationsPath, name), 'utf8'),
    }));
}
