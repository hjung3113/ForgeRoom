import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { runMigrations } from './migrate.js';
import * as schema from './schema.js';

export interface TaskStoreDatabase {
  sqlite: Database.Database;
  db: BetterSQLite3Database<typeof schema>;
  close(): void;
}

export function createTaskStoreDatabase(filename: string): TaskStoreDatabase {
  const sqlite = new Database(filename);
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  tryEnableWal(sqlite);

  return {
    sqlite,
    db: drizzle(sqlite, { schema }),
    close() {
      sqlite.close();
    },
  };
}

export function createSqliteClient(options: { filename: string }): TaskStoreDatabase {
  return createTaskStoreDatabase(options.filename);
}

export function migrateTaskStoreDatabase(database: TaskStoreDatabase): void {
  runMigrations(database.sqlite);
}

function tryEnableWal(sqlite: Database.Database): void {
  try {
    sqlite.pragma('journal_mode = WAL');
  } catch (error) {
    // In-memory databases reject WAL; other journal modes are acceptable there.
    if (error instanceof Error && /WAL/i.test(error.message)) {
      return;
    }
    throw error;
  }
}
