/**
 * Idempotent SQL migrations. Every statement uses IF NOT EXISTS so running
 * migrations repeatedly (also after a restart) is safe.
 */

export const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wells (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id   TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  north_ref   TEXT NOT NULL CHECK (north_ref IN ('true','grid','mag')),
  length_unit TEXT NOT NULL CHECK (length_unit IN ('m','ft')),
  -- Wellhead tie-in in the local plane, stored in METRES.
  head_north  REAL NOT NULL,
  head_east   REAL NOT NULL,
  head_tvd    REAL NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trajectory_versions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  well_id         INTEGER NOT NULL REFERENCES wells(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL,
  reason          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  station_count   INTEGER NOT NULL,
  md_min          REAL NOT NULL,
  md_max          REAL NOT NULL,
  UNIQUE (well_id, version)
);

CREATE TABLE IF NOT EXISTS stations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id          INTEGER NOT NULL REFERENCES trajectory_versions(id) ON DELETE CASCADE,
  seq                 INTEGER NOT NULL,
  md                  REAL NOT NULL,
  inclination_deg     REAL NOT NULL,
  azimuth_deg         REAL NOT NULL,
  client_id           TEXT,
  created_at          TEXT NOT NULL,
  UNIQUE (version_id, seq)
);

CREATE TABLE IF NOT EXISTS courses (
  version_id     INTEGER NOT NULL REFERENCES trajectory_versions(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  md_from        REAL NOT NULL,
  md_to          REAL NOT NULL,
  length         REAL NOT NULL,
  dogleg_deg     REAL NOT NULL,
  dls_per_30m    REAL NOT NULL,
  delta_north    REAL NOT NULL,
  delta_east     REAL NOT NULL,
  delta_tvd      REAL NOT NULL,
  total_north    REAL NOT NULL,
  total_east     REAL NOT NULL,
  total_tvd      REAL NOT NULL,
  PRIMARY KEY (version_id, seq)
);

CREATE TABLE IF NOT EXISTS proximity_reports (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id         TEXT NOT NULL UNIQUE,
  well_a_id         INTEGER NOT NULL REFERENCES wells(id) ON DELETE CASCADE,
  version_a_id      INTEGER NOT NULL REFERENCES trajectory_versions(id) ON DELETE CASCADE,
  well_b_id         INTEGER NOT NULL REFERENCES wells(id) ON DELETE CASCADE,
  version_b_id      INTEGER NOT NULL REFERENCES trajectory_versions(id) ON DELETE CASCADE,
  threshold_metres  REAL,
  min_distance      REAL NOT NULL,
  warning           INTEGER NOT NULL,
  approx_bound      REAL NOT NULL,
  detail_json       TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stations_version ON stations(version_id, seq);
CREATE INDEX IF NOT EXISTS idx_versions_well ON trajectory_versions(well_id, version);

CREATE TABLE IF NOT EXISTS idempotency (
  well_id    INTEGER NOT NULL REFERENCES wells(id) ON DELETE CASCADE,
  version_id INTEGER NOT NULL REFERENCES trajectory_versions(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  PRIMARY KEY (well_id, key)
);
`,
  },
];
