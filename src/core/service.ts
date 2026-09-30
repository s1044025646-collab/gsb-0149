import { Repository, type WellRow } from '../db/repo.ts';
import {
  UNIT_TO_M,
  type LengthUnit,
  type StationInput,
  computeSegments,
  interpolateAtMd,
  SurveyError,
} from './geometry.ts';
import { compareWells, ProximityError, type WellPath } from './proximity.ts';

export class ValidationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}

const NORTH_REFS = new Set(['TRUE_NORTH', 'MAGNETIC_NORTH', 'GRID_NORTH']);

export class Service {
  repo: Repository;
  constructor(repo: Repository) {
    this.repo = repo;
  }

  createWell(body: any) {
    const name = str(body?.name, 'name');
    const northRef = str(body?.northRef, 'northRef').toUpperCase();
    if (!NORTH_REFS.has(northRef)) {
      throw new ValidationError(
        'INVALID_NORTH_REF',
        `northRef must be one of ${[...NORTH_REFS].join(', ')}`,
      );
    }
    const unit = optUnit(body?.unit);
    num(body?.n0 ?? 0, 'n0');
    num(body?.e0 ?? 0, 'e0');
    num(body?.tvd0 ?? 0, 'tvd0');
    return this.repo.createWell({
      name,
      northRef,
      unit,
      n0: body?.n0 ?? 0,
      e0: body?.e0 ?? 0,
      tvd0: body?.tvd0 ?? 0,
    });
  }

  addVersion(wellId: number, body: any) {
    const well = this.repo.getWell(wellId);
    const stations = parseStations(body?.stations, well.length_unit);
    return this.repo.addVersion(wellId, stations, {
      note: typeof body?.note === 'string' ? body.note : '',
      idempotencyKey: body?.idempotencyKey ?? null,
    });
  }

  segments(versionId: number) {
    this.repo.getVersion(versionId);
    const stations = this.repo.getStations(versionId);
    return computeSegments(stations.map((s) => ({ md: s.md_m, inc: s.inc, azi: s.azi })));
  }

  positionAt(versionId: number, mdRaw: number, unit?: LengthUnit) {
    const ver = this.repo.getVersion(versionId);
    const well = this.repo.getWell(ver.well_id);
    const factor = UNIT_TO_M[unit ?? well.length_unit];
    const mdM = Number(mdRaw) * factor;
    if (!Number.isFinite(mdM)) throw new ValidationError('INVALID_MD', 'md must be a number.');
    const pts = this.repo.getTrajectoryPoints(versionId);
    const p = interpolateAtMd(pts, mdM);
    return {
      ...p,
      n: well.n0 + p.n,
      e: well.e0 + p.e,
      tvd: well.tvd0 + p.tvd,
      wellheadApplied: true,
    };
  }

  maxDogleg(versionId: number) {
    const segs = this.segments(versionId);
    if (segs.length === 0) throw new ValidationError('NO_SEGMENTS', 'Need at least two stations.');
    return segs.reduce((m, s) => (s.dlsDegPer30m > m.dlsDegPer30m ? s : m), segs[0]);
  }

  compare(aWellId: number, bWellId: number, thresholdRaw: number, idempotencyKey?: string) {
    const a = this.wellPath(aWellId);
    const b = this.wellPath(bWellId);
    const threshold = Number(thresholdRaw);
    const report = compareWells(a, b, threshold);
    const saved = this.repo.saveDistanceReport({
      idempotencyKey: idempotencyKey ?? null,
      wellAId: aWellId,
      wellBId: bWellId,
      versionAId: this.currentVersionId(aWellId),
      versionBId: this.currentVersionId(bWellId),
      northRef: report.northRef,
      threshold,
      minDistance: report.minDistance,
      withinThreshold: report.withinThreshold,
      payload: report,
    });
    return { reportId: saved.id, reused: saved.reused, report };
  }

  private currentVersionId(wellId: number): number {
    const v = this.repo.latestVersion(wellId);
    if (!v) throw new ValidationError('NO_TRAJECTORY', `Well ${wellId} has no trajectory version.`);
    return v.id;
  }

  private wellPath(wellId: number): WellPath {
    const well: WellRow = this.repo.getWell(wellId);
    const versionId = this.currentVersionId(wellId);
    const points = this.repo.getTrajectoryPoints(versionId);
    return {
      wellId: well.id,
      name: well.name,
      northRef: well.north_ref,
      tieIn: { n0: well.n0, e0: well.e0, tvd0: well.tvd0 },
      points,
    };
  }
}

function str(v: any, field: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ValidationError('INVALID_FIELD', `Field '${field}' must be a non-empty string.`);
  }
  return v.trim();
}

function num(v: any, field: string): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ValidationError('INVALID_FIELD', `Field '${field}' must be a number.`);
  return n;
}

function optUnit(v: any): LengthUnit {
  if (v === undefined || v === null) return 'm';
  if (v !== 'm' && v !== 'ft') throw new ValidationError('INVALID_UNIT', "unit must be 'm' or 'ft'.");
  return v;
}

function parseStations(raw: any, unit: LengthUnit): StationInput[] {
  if (!Array.isArray(raw) || raw.length < 2) {
    throw new ValidationError('INVALID_STATIONS', 'stations must be an array of at least 2 items.');
  }
  return raw.map((s, i) => {
    if (!s || typeof s !== 'object') {
      throw new ValidationError('INVALID_STATIONS', `Station ${i} must be an object.`);
    }
    const md = num(s.md, `stations[${i}].md`);
    const inc = num(s.inc, `stations[${i}].inc`);
    const azi = num(s.azi, `stations[${i}].azi`);
    return { md, inc, azi };
  });
}

export function errorCode(err: unknown): string {
  if (err instanceof ValidationError) return err.code;
  if (err instanceof SurveyError) return err.code;
  if (err instanceof ProximityError) return err.code;
  if ((err as any)?.code?.startsWith?.('SQLITE')) return (err as any).code;
  return 'INTERNAL';
}
