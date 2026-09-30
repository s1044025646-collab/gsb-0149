import { randomUUID } from "node:crypto";
import type { Db } from "./database.js";
import { AppError } from "../core/errors.js";
import { computeTrajectory, type SurveyStation } from "../core/minimumCurvature.js";
import { toMetres, type LengthUnit, type NorthRef } from "../core/units.js";

export interface Clock {
  now(): string;
}

export const isoClock: Clock = { now: () => new Date().toISOString() };

export interface WellRow {
  id: number;
  public_id: string;
  name: string;
  north_ref: NorthRef;
  length_unit: LengthUnit;
  head_north: number;
  head_east: number;
  head_tvd: number;
  created_at: string;
  updated_at: string;
}

export interface StationInput {
  md: number;
  inc: number;
  azi: number;
  clientId?: string | null;
}

export class Repository {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = isoClock,
  ) {}

  createWell(input: {
    name: string;
    northRef: NorthRef;
    lengthUnit: LengthUnit;
    headNorth: number;
 headEast: number;
    headTvd?: number;
    publicId?: string;
  }): WellRow {
    const id = input.publicId ?? randomUUID();
    const ts = this.clock.now();
    try {
      this.db
        .prepare(
          `INSERT INTO wells(public_id, name, north_ref, length_unit, head_north, head_east, head_tvd, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.name,
          input.northRef,
          input.lengthUnit,
          input.headNorth,
          input.headEast,
          input.headTvd ?? 0,
          ts,
          ts,
        );
    } catch (err) {
      if (isUniqueError(err)) {
        throw new AppError("CONFLICT", `well id '${id}' already exists`, { publicId: id });
      }
      throw err;
    }
    return this.getWellByPublicId(id);
  }

  getWellByPublicId(publicId: string): WellRow {
    const row = this.db.prepare("SELECT * FROM wells WHERE public_id = ?").get(publicId) as
      | WellRow
      | undefined;
    if (!row) throw new AppError("NOT_FOUND", `well '${publicId}' not found`, { publicId });
    return row;
  }

  listWells(limit: number, offset: number): { rows: WellRow[]; total: number } {
    const total = (this.db.prepare("SELECT COUNT(*) AS c FROM wells").get() as { c: number }).c;
    const rows = this.db
      .prepare("SELECT * FROM wells ORDER BY id ASC LIMIT ? OFFSET ?")
      .all(limit, offset) as unknown as WellRow[];
    return { rows, total };
  }

  listVersions(wellId: number, limit: number, offset: number) {
    const total = (
      this.db.prepare("SELECT COUNT(*) AS c FROM trajectory_versions WHERE well_id = ?").get(wellId) as {
        c: number;
      }
    ).c;
    const rows = this.db
      .prepare(
        "SELECT * FROM trajectory_versions WHERE well_id = ? ORDER BY version DESC LIMIT ? OFFSET ?",
      )
      .all(wellId, limit, offset) as unknown as {
        id: number;
        well_id: number;
        version: number;
        reason: string;
        created_at: string;
        station_count: number;
        md_min: number;
        md_max: number;
      }[];
    return { rows, total };
  }

  getLatestVersion(wellId: number) {
    const row = this.db
      .prepare("SELECT * FROM trajectory_versions WHERE well_id = ? ORDER BY version DESC LIMIT 1")
      .get(wellId) as
      | {
          id: number;
          well_id: number;
          version: number;
          reason: string;
          created_at: string;
          station_count: number;
          md_min: number;
          md_max: number;
        }
      | undefined;
    return row ?? null;
  }

  getVersion(wellId: number, version: number) {
    const row = this.db
      .prepare("SELECT * FROM trajectory_versions WHERE well_id = ? AND version = ?")
      .get(wellId, version) as
      | {
          id: number;
          version: number;
          reason: string;
          station_count: number;
          md_min: number;
          md_max: number;
        }
      | undefined;
    if (!row) throw new AppError("NOT_FOUND", `version ${version} not found`, { version });
    return row;
  }

  /**
   * Append a new trajectory version for a well. Station md values arrive in the
   * well's declared length unit and are converted to metres before storage and
   * computation. Fully transactional: invalid input rolls everything back.
   *
   * Idempotency: when idempotencyKey matches the last import for this well the
   * existing version is returned unchanged.
   */
  addVersion(
    well: WellRow,
    stations: StationInput[],
    reason: string,
    options: { idempotencyKey?: string | null } = {},
  ): { version: number; versionId: number; reused: boolean } {
    if (options.idempotencyKey) {
      const existing = this.db
        .prepare(
          `SELECT tv.id AS version_id, tv.version FROM idempotency i
           JOIN trajectory_versions tv ON tv.id = i.version_id
           WHERE i.well_id = ? AND i.key = ?`,
        )
        .get(well.id, options.idempotencyKey) as { version_id: number; version: number } | undefined;
      if (existing) {
        return { versionId: existing.version_id, version: existing.version, reused: true };
      }
    }

    const converted: SurveyStation[] = stations.map((s) => ({
      md: toMetres(s.md, well.length_unit),
      inc: s.inc,
      azi: s.azi,
    }));

    // Compute before opening the write transaction so malformed input fails fast.
    const result = computeTrajectory(converted);

    this.db.exec("BEGIN");
    try {
      const last = this.db
        .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM trajectory_versions WHERE well_id = ?")
        .get(well.id) as { v: number };
      const version = last.v + 1;
      const ts = this.clock.now();

      const versionResult = this.db
        .prepare(
          `INSERT INTO trajectory_versions(well_id, version, reason, created_at, station_count, md_min, md_max)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          well.id,
          version,
          reason,
          ts,
          converted.length,
          converted[0]!.md,
          converted[converted.length - 1]!.md,
        );
      const versionId = Number(versionResult.lastInsertRowid);

      const insStation = this.db.prepare(
        `INSERT INTO stations(version_id, seq, md, inclination_deg, azimuth_deg, client_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const insCourse = this.db.prepare(
        `INSERT INTO courses(version_id, seq, md_from, md_to, length, dogleg_deg, dls_per_30m,
           delta_north, delta_east, delta_tvd, total_north, total_east, total_tvd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      converted.forEach((s, i) => {
        insStation.run(
          versionId,
          i,
          s.md,
          s.inc,
          s.azi,
          stations[i]!.clientId ?? null,
          ts,
        );
      });

      result.courses.forEach((c) => {
        insCourse.run(
          versionId,
          c.fromIndex,
          c.mdFrom,
          c.mdTo,
          c.length,
          c.doglegDeg,
          c.dlsPer30m,
          c.deltaN,
          c.deltaE,
          c.deltaTvd,
          c.totalN,
          c.totalE,
          c.totalTvd,
        );
      });

      if (options.idempotencyKey) {
        this.db
          .prepare("INSERT OR IGNORE INTO idempotency(well_id, version_id, key) VALUES (?, ?, ?)")
          .run(well.id, versionId, options.idempotencyKey);
      }

      this.db
        .prepare("UPDATE wells SET updated_at = ? WHERE id = ?")
        .run(ts, well.id);

      this.db.exec("COMMIT");
      return { versionId, version, reused: false };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getStations(versionId: number, limit: number, offset: number) {
    const total = (
      this.db.prepare("SELECT COUNT(*) AS c FROM stations WHERE version_id = ?").get(versionId) as {
        c: number;
      }
    ).c;
    const rows = this.db
      .prepare(
        "SELECT seq, md, inclination_deg AS inc, azimuth_deg AS azi, client_id AS clientId, created_at AS createdAt FROM stations WHERE version_id = ? ORDER BY seq ASC LIMIT ? OFFSET ?",
      )
      .all(versionId, limit, offset) as unknown as {
        seq: number;
        md: number;
        inc: number;
        azi: number;
        clientId: string | null;
        createdAt: string;
      }[];
    return { rows, total };
  }

  getAllStations(versionId: number) {
    return this.db
      .prepare(
        "SELECT seq, md, inclination_deg AS inc, azimuth_deg AS azi FROM stations WHERE version_id = ? ORDER BY seq ASC",
      )
      .all(versionId) as unknown as { seq: number; md: number; inc: number; azi: number }[];
  }

  getCourses(versionId: number, limit: number, offset: number) {
    const total = (
      this.db.prepare("SELECT COUNT(*) AS c FROM courses WHERE version_id = ?").get(versionId) as {
        c: number;
      }
    ).c;
    const rows = this.db
      .prepare(
        `SELECT seq, md_from AS mdFrom, md_to AS mdTo, length, dogleg_deg AS doglegDeg,
                dls_per_30m AS dlsPer30m, delta_north AS deltaNorth, delta_east AS deltaEast,
                delta_tvd AS deltaTvd, total_north AS totalNorth, total_east AS totalEast,
                total_tvd AS totalTvd
         FROM courses WHERE version_id = ? ORDER BY seq ASC LIMIT ? OFFSET ?`,
      )
      .all(versionId, limit, offset) as unknown as Record<string, number>[];
    return { rows, total };
  }

  saveProximityReport(input: {
    publicId: string;
    wellAId: number;
    versionAId: number;
    wellBId: number;
    versionBId: number;
    threshold: number | null;
    minDistance: number;
    warning: boolean;
    approxBound: number;
    detail: unknown;
  }) {
    try {
      this.db
        .prepare(
          `INSERT INTO proximity_reports(public_id, well_a_id, version_a_id, well_b_id, version_b_id,
             threshold_metres, min_distance, warning, approx_bound, detail_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.publicId,
          input.wellAId,
          input.versionAId,
          input.wellBId,
          input.versionBId,
          input.threshold,
          input.minDistance,
          input.warning ? 1 : 0,
          input.approxBound,
          JSON.stringify(input.detail),
          this.clock.now(),
        );
    } catch (err) {
      if (isUniqueError(err)) {
        throw new AppError("CONFLICT", `report '${input.publicId}' already exists`);
      }
      throw err;
    }
  }

  listReports(limit: number, offset: number) {
    const total = (
      this.db.prepare("SELECT COUNT(*) AS c FROM proximity_reports").get() as { c: number }
    ).c;
    const rows = this.db
      .prepare(
        `SELECT pr.public_id AS publicId, wa.public_id AS wellA, wb.public_id AS wellB,
                pr.min_distance AS minDistance, pr.warning, pr.threshold_metres AS threshold,
                pr.approx_bound AS approxBound, pr.created_at AS createdAt
         FROM proximity_reports pr
         JOIN wells wa ON wa.id = pr.well_a_id
         JOIN wells wb ON wb.id = pr.well_b_id
         ORDER BY pr.id DESC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as unknown as Record<string, unknown>[];
    return { rows, total };
  }
}

function isUniqueError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; errcode?: number; message?: string };
  return (
    e.code === "SQLITE_CONSTRAINT_UNIQUE" ||
    e.errcode === 2067 /* SQLITE_CONSTRAINT_UNIQUE */ ||
    typeof e.message === "string" && e.message.includes("UNIQUE constraint failed")
  );
}
