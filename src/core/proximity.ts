import { segmentSegmentDistance, type TrajectoryPoint, type Vec3 } from './geometry.ts';

/**
 * Well-to-well proximity based on the shortest distance between reconstructed
 * trajectory POLYLINE SEGMENTS — not merely between survey stations.
 *
 * Important limitations (also surfaced in the report):
 *  - Trajectories are piecewise-linear approximations of the true (smooth)
 *    well path. The true path bows away from each chord, so this report has a
 *    chord-approximation error that shrinks with station density.
 *  - Crossing a distance threshold is a WARNING / screening result, NOT proof
 *    of a safe clearance. No positional/measurement uncertainty (error ellipsoid)
 *    is modelled, therefore NO probabilistic collision risk is provided.
 */

export interface TieIn {
  n0: number;
  e0: number;
  tvd0: number;
}

export interface WellPath {
  wellId: number;
  name: string;
  northRef: string;
  tieIn: TieIn;
  points: TrajectoryPoint[];
}

export interface ClosestPair {
  distance: number;
  mdA: number;
  mdB: number;
  pointA: Vec3;
  pointB: Vec3;
  segAIndex: number;
  segBIndex: number;
}

export interface ProximityReport {
  wellA: string;
  wellB: string;
  northRef: string;
  threshold: number;
  minDistance: number;
  withinThreshold: boolean;
  closest: ClosestPair;
  pairCount: number;
  limitations: string[];
}

function toWorld(p: TrajectoryPoint, t: TieIn): Vec3 {
  return { n: t.n0 + p.n, e: t.e0 + p.e, v: t.tvd0 + p.tvd };
}

/** Closest point parameters on two finite segments, reused from geometry via distance. */
function closestOnSegments(a0: Vec3, a1: Vec3, b0: Vec3, b1: Vec3) {
  const d1 = { n: a1.n - a0.n, e: a1.e - a0.e, v: a1.v - a0.v };
  const d2 = { n: b1.n - b0.n, e: b1.e - b0.e, v: b1.v - b0.v };
  const r = { n: a0.n - b0.n, e: a0.e - b0.e, v: a0.v - b0.v };
  const aa = d1.n * d1.n + d1.e * d1.e + d1.v * d1.v;
  const ee = d2.n * d2.n + d2.e * d2.e + d2.v * d2.v;
  const ff = d2.n * r.n + d2.e * r.e + d2.v * r.v;
  let s = 0;
  let t = 0;
  if (aa <= 1e-15 && ee <= 1e-15) {
    s = 0;
    t = 0;
  } else if (aa <= 1e-15) {
    t = Math.max(0, Math.min(1, ff / ee));
  } else {
    const c = d1.n * r.n + d1.e * r.e + d1.v * r.v;
    if (ee <= 1e-15) {
      s = Math.max(0, Math.min(1, -c / aa));
    } else {
      const b = d1.n * d2.n + d1.e * d2.e + d1.v * d2.v;
      const denom = aa * ee - b * b;
      if (Math.abs(denom) > 1e-12 * Math.max(1, aa * ee)) {
        s = Math.max(0, Math.min(1, (b * ff - c * ee) / denom));
        t = (b * s + ff) / ee;
        if (t < 0) {
          t = 0;
          s = Math.max(0, Math.min(1, -c / aa));
        } else if (t > 1) {
          t = 1;
          s = Math.max(0, Math.min(1, (b - c) / aa));
        }
      } else {
        const candidates: [number, number][] = [
          [Math.max(0, Math.min(1, -c / aa)), 0],
          [Math.max(0, Math.min(1, (b - c) / aa)), 1],
        ];
        let best = Infinity;
        s = 0;
        t = 0;
        for (const [sc, tc] of candidates) {
          const pn = a0.n + d1.n * sc;
          const pe = a0.e + d1.e * sc;
          const pv = a0.v + d1.v * sc;
          const qn = b0.n + d2.n * tc;
          const qe = b0.e + d2.e * tc;
          const qv = b0.v + d2.v * tc;
          const dd = (pn - qn) ** 2 + (pe - qe) ** 2 + (pv - qv) ** 2;
          if (dd < best) {
            best = dd;
            s = sc;
            t = tc;
          }
        }
      }
    }
  }
  const pa = { n: a0.n + d1.n * s, e: a0.e + d1.e * s, v: a0.v + d1.v * s };
  const pb = { n: b0.n + d2.n * t, e: b0.e + d2.e * t, v: b0.v + d2.v * t };
  return { s, t, pa, pb };
}

export const PROXIMITY_LIMITATIONS = [
  'Distances are computed between piecewise-linear reconstructed trajectory segments; chord approximation error is not bounded here.',
  'Threshold breach is a screening warning only and is not proof of safe clearance.',
  'No error-ellipsoid / positional-uncertainty model is included, so no probabilistic collision risk is reported.',
];

export class ProximityError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProximityError';
    this.code = code;
  }
}

/**
 * Compare two wells. North references must match exactly; mixing references is
 * rejected rather than silently rotated.
 */
export function compareWells(a: WellPath, b: WellPath, threshold: number): ProximityReport {
  if (a.northRef !== b.northRef) {
    throw new ProximityError(
      'NORTH_REF_MISMATCH',
      `Cannot compare wells with different north references: ${a.northRef} vs ${b.northRef}.`,
    );
  }
  if (!(threshold > 0)) {
    throw new ProximityError('INVALID_THRESHOLD', 'Threshold must be a positive number of metres.');
  }
  if (a.points.length < 2 || b.points.length < 2) {
    throw new ProximityError('INSUFFICIENT_STATIONS', 'Each well needs at least two stations.');
  }

  let best: ClosestPair | null = null;
  let pairCount = 0;

  for (let i = 0; i < a.points.length - 1; i++) {
    const a0 = toWorld(a.points[i], a.tieIn);
    const a1 = toWorld(a.points[i + 1], a.tieIn);
    for (let j = 0; j < b.points.length - 1; j++) {
      const b0 = toWorld(b.points[j], b.tieIn);
      const b1 = toWorld(b.points[j + 1], b.tieIn);
      const { s, t, pa, pb } = closestOnSegments(a0, a1, b0, b1);
      const d = segmentSegmentDistance(a0, a1, b0, b1);
      pairCount++;
      if (best === null || d < best.distance) {
        best = {
          distance: d,
          mdA: a.points[i].md + (a.points[i + 1].md - a.points[i].md) * s,
          mdB: b.points[j].md + (b.points[j + 1].md - b.points[j].md) * t,
          pointA: pa,
          pointB: pb,
          segAIndex: i,
          segBIndex: j,
        };
      }
    }
  }

  const closest = best as ClosestPair;
  return {
    wellA: a.name,
    wellB: b.name,
    northRef: a.northRef,
    threshold,
    minDistance: closest.distance,
    withinThreshold: closest.distance <= threshold,
    closest,
    pairCount,
    limitations: PROXIMITY_LIMITATIONS,
  };
}


