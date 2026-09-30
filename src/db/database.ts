import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS } from "./migrations.js";

export type Db = DatabaseSync;

/**
 * Open (or create) a SQLite database and ensure every migration has run.
 * Migrations are tracked in schema_meta and are individually idempotent.
 */
export function openDatabase(path: string): Db {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
  );
  const get = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'");
  const row = get.get() as { value: string } | undefined;
  const current = row ? Number(row.value) : 0;

  const setVersion = db.prepare(
    "INSERT INTO schema_meta(key, value) VALUES ('schema_version', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );

  for (const m of MIGRATIONS) {
    if (m.id > current) {
      db.exec("BEGIN");
      try {
        db.exec(m.sql);
        setVersion.run(String(m.id));
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    } else {
      // Re-run idempotent DDL on every startup to guarantee repeatability.
      db.exec(m.sql);
    }
  }
}

export function closeDatabase(db: Db): void {
  db.close();
}
