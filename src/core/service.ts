import { randomUUID } from "node:crypto";
import type { Repository, WellRow } from "../db/repository.js";
import { AppError } from "./errors.js";
import {
  computeTrajectory,
  interpolateAtMd,
  maximumDogleg,
  type TrajectoryPoint,
  type TrajectoryResult,
} from "./minimumCurvature.js";
import { polylineFromPoints, wellProximity, type ProximityReport } from "./proximity.js";
import { fromMetres, toMetres, type LengthUnit } from "./units.js";

export interface ReconstructedWell {
  well: WellRow;
  version: number;
  result: TrajectoryResult;
  /** World (local-plane) points = relative trajectory + wellhead tie-in. */
  world: TrajectoryPoint[];
}

export class TrajectoryService {
  constructor(private readonly repo: Repository) {}

  reconstruct(publicId: string, version?: number): ReconstructedWell {
    const well = this.repo.getWellByPublicId(publicId);
    const v =
      version === undefined
        ? this.repo.getLatestVersion(well.id)
        : this.repo.getVersion(well.id, version);
    if (!v) {
      throw new AppError("NOT_FOUND", `well '${publicId}' has no trajectory versions yet`);
    }
    const stations = this.repo.getAllStations(v.id);
    const result = computeTrajectory(stations);
    const world = result.points.map((p) => ({
      ...p,
      n: well.head_north + p.n,
      e: well.head_east + p.e,
      z: well.head_tvd + p.z,
    }));
    return { well, version: v.version, result, world };
  }

  /** Query a position at an arbitrary measured depth (given in the well's unit). */
  queryAtMd(publicId: string, md: number, version?: number) {
    const rec = this.reconstruct(publicId, version);
    if (!Number.isFinite(md) || md < 0) {
      throw new AppError("VALIDATION", "measured depth must be a finite non-negative number");
    }
    const mdMetres = toMetres(md, rec.well.length_unit);
    const { point, courseIndex, fraction } = interpolateAtMd(rec.result, mdMetres);
    return {
      well: publicId,
      version: rec.version,
      requestedMd: md,
      unit: rec.well.length_unit,
      courseIndex,
      fraction,
      relative: { north: point.n, east: point.e, tvd: point.z },
      world: {
        north: rec.well.head_north + point.n,
        east: rec.well.head_east + point.e,
        tvd: rec.well.head_tvd + point.z,
      },
      inclinationDeg: point.inc,
      azimuthDeg: point.azi,
    };
  }

  maxDogleg(publicId: string, version?: number) {
    const rec = this.reconstruct(publicId, version);
    const best = maximumDogleg(rec.result);
    if (!best) {
      throw new AppError("VALIDATION", "trajectory has a single station; no courses exist");
    }
    const u = rec.well.length_unit;
    return {
      well: publicId,
      version: rec.version,
      course: {
        ...best,
        mdFrom: fromMetres(best.mdFrom, u),
        mdTo: fromMetres(best.mdTo, u),
        length: fromMetres(best.length, u),
      },
      unit: u,
    };
  }

  compareWells(
    idA: string,
    idB: string,
    options: {
      versionA?: number;
      versionB?: number;
      threshold?: number | null;
      thresholdUnit?: LengthUnit;
      reportId?: string;
    } = {},
  ): ProximityReport & { wellA: string; wellB: string; versionA: number; versionB: number } {
    const a = this.reconstruct(idA, options.versionA);
    const b = this.reconstruct(idB, options.versionB);

    let thresholdMetres: number | null = null;
    if (options.threshold !== undefined && options.threshold !== null) {
      const unit = options.thresholdUnit ?? "m";
      if (!Number.isFinite(options.threshold) || options.threshold < 0) {
        throw new AppError("VALIDATION", "threshold must be a non-negative finite number");
      }
      thresholdMetres = toMetres(options.threshold, unit);
    }

    const pa = polylineFromPoints(a.world);
    const pb = polylineFromPoints(b.world);
    const report = wellProximity(pa, pb, a.well.north_ref, b.well.north_ref, {
      thresholdMetres,
    });

    this.repo.saveProximityReport({
      publicId: options.reportId ?? randomUUID(),
      wellAId: a.well.id,
      versionAId: this.repo.getVersion(a.well.id, a.version).id,
      wellBId: b.well.id,
      versionBId: this.repo.getVersion(b.well.id, b.version).id,
      threshold: thresholdMetres,
      minDistance: report.minimumDistance,
      warning: report.warning,
      approxBound: report.approximationBoundMetres,
      detail: report,
    });

    return {
      ...report,
      wellA: idA,
      wellB: idB,
      versionA: a.version,
      versionB: b.version,
    };
  }
}
