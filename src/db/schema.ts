/**
 * Repeatable idempotent schema migrations. Every statement uses IF NOT EXISTS so
 * running migrations on an existing database is safe.
 */
import type { DatabaseSync } from 'node:sqlite';

const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
    CREATE TABLE IF NOT EXISTS wells (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      north_ref TEXT NOT NULL,
      length_unit TEXT NOT NULL DEFAULT 'm',
      n0 REAL NOT NULL DEFAULT 0,
      e0 REAL NOT NULL DEFAULT 0,
      tvd0 REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trajectory_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      well_id INTEGER NOT NULL REFERENCES wells(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(well_id, version),
      UNIQUE(well_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS stations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version_id INTEGER NOT NULL REFERENCES trajectory_versions(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      md_raw REAL NOT NULL,
      unit TEXT NOT NULL,
      md_m REAL NOT NULL,
      inc REAL NOT NULL,
      azi REAL NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(version_id, seq)
    );

    CREATE TABLE IF NOT EXISTS distance_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT,
      well_a_id INTEGER NOT NULL REFERENCES wells(id),
      well_b_id INTEGER NOT NULL REFERENCES wells(id),
      version_a_id INTEGER NOT NULL REFERENCES trajectory_versions(id),
      version_b_id INTEGER NOT NULL REFERENCES trajectory_versions(id),
      north_ref TEXT NOT NULL,
      threshold REAL NOT NULL,
      min_distance REAL NOT NULL,
      within_threshold INTEGER NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(well_a_id, well_b_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    `,
  },
];

export function migrate(db: DatabaseSync): { from: number; to: number } {
  db.exec('CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as
    | { value: string }
    | undefined;
  const current = row ? Number(row.value) : 0;
  let applied = current;
  for (const m of MIGRATIONS) {
    if (m.id > current) {
      db.exec(m.sql);
      applied = m.id;
    }
  }
  db.prepare(
    `INSERT INTO schema_meta(key,value) VALUES('version',?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  ).run(String(applied));
  return { from: current, to: applied };
}
