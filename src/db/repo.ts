import { DatabaseSync } from 'node:sqlite';
import { migrate } from './schema.ts';
import {
  UNIT_TO_M,
  type LengthUnit,
  type StationInput,
  computeSegments,
  rebuildTrajectory,
  SurveyError,
} from '../core/geometry.ts';

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

export interface WellRow {
  id: number;
  name: string;
  north_ref: string;
  length_unit: LengthUnit;
  n0: number;
  e0: number;
  tvd0: number;
  created_at: string;
}

export interface StationRow {
  seq: number;
  md_raw: number;
  unit: LengthUnit;
  md_m: number;
  inc: number;
  azi: number;
}

export class RepoError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RepoError';
    this.code = code;
  }
}

export class Repository {
  readonly db: DatabaseSync;
  private clock: Clock;

  constructor(
    db: DatabaseSync,
    clock: Clock = systemClock,
  ) {
    this.db = db;
    this.clock = clock;
    db.exec('PRAGMA foreign_keys = ON;');
  }

  static open(path: string, clock: Clock = systemClock): Repository {
    const db = new DatabaseSync(path);
    const repo = new Repository(db, clock);
    repo.migrate();
    return repo;
  }

  migrate() {
    return migrate(this.db);
  }

  close() {
    this.db.close();
  }

  ts(): string {
    return this.clock.now().toISOString();
  }

  createWell(input: {
    name: string;
    northRef: string;
    unit?: LengthUnit;
    n0?: number;
    e0?: number;
    tvd0?: number;
  }): WellRow {
    const unit: LengthUnit = input.unit ?? 'm';
    try {
      const info = this.db
        .prepare(
          `INSERT INTO wells(name, north_ref, length_unit, n0, e0, tvd0, created_at)
           VALUES(?,?,?,?,?,?,?)`,
        )
        .run(
          input.name,
          input.northRef,
          unit,
          input.n0 ?? 0,
          input.e0 ?? 0,
          input.tvd0 ?? 0,
          this.ts(),
        );
      return this.getWell(Number(info.lastInsertRowid));
    } catch (err) {
      throw mapSqlite(err, 'WELL_EXISTS', `Well '${input.name}' already exists.`);
    }
  }

  getWell(id: number): WellRow {
    const row = this.db.prepare('SELECT * FROM wells WHERE id=?').get(id) as WellRow | undefined;
    if (!row) throw new RepoError('WELL_NOT_FOUND', `Well ${id} not found.`);
    return row;
  }

  getWellByName(name: string): WellRow | undefined {
    return this.db.prepare('SELECT * FROM wells WHERE name=?').get(name) as WellRow | undefined;
  }

  listWells(limit = 50, offset = 0): { data: WellRow[]; total: number } {
    const total = (this.db.prepare('SELECT COUNT(*) c FROM wells').get() as { c: number }).c;
    const data = this.db
      .prepare('SELECT * FROM wells ORDER BY id LIMIT ? OFFSET ?')
      .all(limit, offset) as unknown as WellRow[];
    return { data, total };
  }

  latestVersion(wellId: number): { id: number; version: number } | undefined {
    return this.db
      .prepare('SELECT id, version FROM trajectory_versions WHERE well_id=? ORDER BY version DESC LIMIT 1')
      .get(wellId) as { id: number; version: number } | undefined;
  }

  listVersions(wellId: number) {
    return this.db
      .prepare('SELECT * FROM trajectory_versions WHERE well_id=? ORDER BY version')
      .all(wellId) as unknown as any[];
  }

  /**
   * Append a new trajectory version for a well. Revising any station creates a
   * NEW immutable version; previous versions stay intact (history isolation).
   * Re-submitting the same idempotency key returns the existing version.
   * Geometry is validated inside the transaction; failure rolls everything back.
   */
  addVersion(
    wellId: number,
    stations: StationInput[],
    opts: { note?: string; idempotencyKey?: string | null } = {},
  ): { versionId: number; version: number; reused: boolean } {
    const well = this.getWell(wellId);
    const key = opts.idempotencyKey ?? null;

    if (key) {
      const existing = this.db
        .prepare('SELECT id, version FROM trajectory_versions WHERE well_id=? AND idempotency_key=?')
        .get(wellId, key) as { id: number; version: number } | undefined;
      if (existing) return { versionId: existing.id, version: existing.version, reused: true };
    }

    const save = this.db.prepare(
      `INSERT INTO trajectory_versions(well_id, version, note, idempotency_key, created_at)
       VALUES(?,?,?,?,?)`,
    );
    const insStation = this.db.prepare(
      `INSERT INTO stations(version_id, seq, md_raw, unit, md_m, inc, azi, created_at)
       VALUES(?,?,?,?,?,?,?,?)`,
    );

    try {
      this.db.exec('BEGIN IMMEDIATE');
      const prev = this.db
        .prepare('SELECT COALESCE(MAX(version),0) v FROM trajectory_versions WHERE well_id=?')
        .get(wellId) as { v: number };
      const version = prev.v + 1;
      const factor = UNIT_TO_M[well.length_unit];
      // Convert to metres and validate geometry before persisting anything.
      const inMetres = stations.map((s) => ({ md: s.md * factor, inc: s.inc, azi: s.azi }));
      computeSegments(inMetres); // throws on invalid data

      const info = save.run(wellId, version, opts.note ?? '', key, this.ts());
      const versionId = Number(info.lastInsertRowid);
      inMetres.forEach((s, i) => {
        insStation.run(versionId, i, stations[i].md, well.length_unit, s.md, s.inc, s.azi, this.ts());
      });
      this.db.exec('COMMIT');
      const r = { versionId, version };
      return { ...r, reused: false };
    } catch (err) {
      this.db.exec('ROLLBACK');
      if (err instanceof SurveyError) throw err;
      throw mapSqlite(err, 'VERSION_EXISTS', 'Could not create trajectory version.');
    }
  }

  getStations(versionId: number): StationRow[] {
    return this.db
      .prepare('SELECT * FROM stations WHERE version_id=? ORDER BY seq')
      .all(versionId) as unknown as StationRow[];
  }

  /** Load a version as metre-space trajectory points (relative to wellhead). */
  getTrajectoryPoints(versionId: number) {
    const stations = this.getStations(versionId).map((s) => ({
      md: s.md_m,
      inc: s.inc,
      azi: s.azi,
    }));
    return rebuildTrajectory(stations);
  }

  getVersion(versionId: number) {
    const row = this.db
      .prepare('SELECT * FROM trajectory_versions WHERE id=?')
      .get(versionId) as any | undefined;
    if (!row) throw new RepoError('VERSION_NOT_FOUND', `Version ${versionId} not found.`);
    return row;
  }

  saveDistanceReport(input: {
    idempotencyKey?: string | null;
    wellAId: number;
    wellBId: number;
    versionAId: number;
    versionBId: number;
    northRef: string;
    threshold: number;
    minDistance: number;
    withinThreshold: boolean;
    payload: unknown;
  }): { id: number; reused: boolean } {
    const key = input.idempotencyKey ?? null;
    if (key) {
      const existing = this.db
        .prepare(
          `SELECT id FROM distance_reports
           WHERE well_a_id=? AND well_b_id=? AND idempotency_key=?`,
        )
        .get(input.wellAId, input.wellBId, key) as { id: number } | undefined;
      if (existing) return { id: existing.id, reused: true };
    }
    const info = this.db
      .prepare(
        `INSERT INTO distance_reports(idempotency_key, well_a_id, well_b_id, version_a_id,
           version_b_id, north_ref, threshold, min_distance, within_threshold, payload, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        key,
        input.wellAId,
        input.wellBId,
        input.versionAId,
        input.versionBId,
        input.northRef,
        input.threshold,
        input.minDistance,
        input.withinThreshold ? 1 : 0,
        JSON.stringify(input.payload),
        this.ts(),
      );
    return { id: Number(info.lastInsertRowid), reused: false };
  }

  listReports(limit = 20, offset = 0): { data: any[]; total: number } {
    const total = (this.db.prepare('SELECT COUNT(*) c FROM distance_reports').get() as { c: number })
      .c;
    const data = this.db
      .prepare('SELECT * FROM distance_reports ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as unknown as any[];
    return { data, total };
  }
}

function mapSqlite(err: unknown, code: string, message: string): Error {
  const e = err as { code?: string; message?: string };
  const isConstraint =
    (e?.code && String(e.code).startsWith('SQLITE_CONSTRAINT')) ||
    /constraint failed/i.test(e?.message ?? '');
  if (isConstraint) {
    return new RepoError(code, message);
  }
  return err instanceof Error ? err : new RepoError('DB_ERROR', message);
}
