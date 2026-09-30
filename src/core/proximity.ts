/**
 * Inter-well proximity from reconstructed 3D polylines.
 *
 * Distance is the minimum over ALL pairs of wellbore SEGMENTS of the
 * segment-to-segment shortest distance — not merely station-to-station.
 * Both wells must share the same length unit (converted to metres) and the
 * same north reference; otherwise comparison is refused.
 *
 * IMPORTANT modelling caveats:
 *  - The polyline is an approximation of the true continuous wellbore. The
 *    shortest true distance can be slightly SMALLER than the reported value
 *    between survey stations; use the survey spacing as an error budget.
 *  - A threshold "warning" is geometric proximity only. It is NOT proof of
 *    collision safety and, without an error-ellipsoid / uncertainty model,
    NO probabilistic collision risk is provided.
 */

import { AppError } from "./errors.js";
import type { NorthRef } from "./units.js";
import type { Vec3 } from "./geometry.js";
import { sub } from "./geometry.js";

export interface Segment {
  a: Vec3;
  b: Vec3;
}

export interface SegmentDistanceResult {
  distance: number;
  /** Closest point on segment 1. */
  p1: Vec3;
  /** Closest point on segment 2. */
  p2: Vec3;
  s: number;
  t: number;
}

function pointOn(a: Vec3, b: Vec3, s: number): Vec3 {
  return {
    n: a.n + (b.n - a.n) * s,
    e: a.e + (b.e - a.e) * s,
    z: a.z + (b.z - a.z) * s,
  };
}

/**
 * Shortest distance between two finite 3D segments (Ericson / Real-Time
 * Collision algorithm). Handles parallel and degenerate segments.
 */
export function segmentSegmentDistance(s1: Segment, s2: Segment): SegmentDistanceResult {
  const u = sub(s1.b, s1.a);
  const v = sub(s2.b, s2.a);
  const w = sub(s2.a, s1.a); // C - P
  const uu = u.n * u.n + u.e * u.e + u.z * u.z;
  const uv = u.n * v.n + u.e * v.e + u.z * v.z;
  const vv = v.n * v.n + v.e * v.e + v.z * v.z;
  const uw = u.n * w.n + u.e * w.e + u.z * w.z;
  const vw = v.n * w.n + v.e * w.e + v.z * w.z;
  const D = uu * vv - uv * uv;

  let s = 0;
  let t = 0;
  let bestS = 0;
  let bestT = 0;
  let bestD = Infinity;

  // Objective f(s,t) = |s u - t v - w|^2, with w = Q - P so the vector
  // between points is P + s u - (Q + t v) = -(w + t v - s u). Stationarity:
  //   uu s - uv t = -uw'  where w here = Q-P, uw = u.(Q-P), vw = v.(Q-P)
  // Use the standard interior solve and, if outside the unit square, clamp
  // each active region and re-minimize. Enumerating candidate regions is
  // robust for parallel/degenerate cases instead of fragile branch ordering.
  const consider = (cs: number, ct: number) => {
    const p1 = pointOn(s1.a, s1.b, cs);
    const p2 = pointOn(s2.a, s2.b, ct);
    const d = sub(p1, p2);
    const dist = d.n * d.n + d.e * d.e + d.z * d.z;
    if (dist < bestD) {
      bestD = dist;
      bestS = cs;
      bestT = ct;
    }
  };

  if (uu > 1e-12 && vv > 1e-12 && Math.abs(D) > 1e-12 * Math.max(1, uu * vv)) {
    // |w + t v - s u|^2 stationarity:
    //   uu*s - uv*t = uw
    //   uv*s - vv*t = vw
    s = (vv * uw - uv * vw) / D;
    t = (uv * s - vw) / vv;
    if (s >= 0 && s <= 1 && t >= 0 && t <= 1) consider(s, t);
  }

  // Boundaries s in {0,1}: minimize over t in [0,1].
  if (vv > 1e-12) {
    consider(0, clamp01(vw / vv));
    consider(1, clamp01((vw + uv) / vv));
  }
  // Boundaries t in {0,1}: minimize over s in [0,1].
  if (uu > 1e-12) {
    consider(clamp01(uw / uu), 0);
    consider(clamp01((uw + uv) / uu), 1);
  }
  // Corners (covers degenerate segments and ties).
  consider(0, 0);
  consider(0, 1);
  consider(1, 0);
  consider(1, 1);

  s = bestS;
  t = bestT;

  const p1 = pointOn(s1.a, s1.b, s);
  const p2 = pointOn(s2.a, s2.b, t);
  const delta = sub(p1, p2);
  return {
    distance: Math.hypot(delta.n, delta.e, delta.z),
    p1,
    p2,
    s,
    t,
  };
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

export interface Polyline {
  points: Vec3[];
}

export interface ProximityBreach {
  segmentIndexA: number;
  segmentIndexB: number;
  distance: number;
  pointA: Vec3;
  pointB: Vec3;
}

export interface ProximityReport {
  minimumDistance: number;
  thresholdMetres: number | null;
  warning: boolean;
  closest: ProximityBreach;
  /** All segment pairs within the threshold (omitted when no threshold). */
  breaches: ProximityBreach[];
  northRef: NorthRef;
  /**
   * Upper bound on the polyline approximation undershoot: each closest point
   * can shift by at most ~ half the local chord spacing. Conservative sum.
   */
  approximationBoundMetres: number;
}

export function assertComparable(refA: NorthRef, refB: NorthRef): void {
  if (refA !== refB) {
    throw new AppError(
      "NORTH_REF_MISMATCH",
      `cannot compare trajectories with different north references: ${refA} vs ${refB}. Re-reduce surveys against a common reference first.`,
      { northRefA: refA, northRefB: refB },
    );
  }
}

export function polylineFromPoints(points: Vec3[]): Polyline {
  if (points.length < 2) {
    throw new AppError("VALIDATION", "a trajectory needs at least two stations to form segments");
  }
  return { points };
}

/**
 * Minimum segment-to-segment distance between two reconstructed wellbores.
 */
export function wellProximity(
    a: Polyline,
    b: Polyline,
    northRefA: NorthRef,
    northRefB: NorthRef,
    options: { thresholdMetres?: number | null } = {},
  ): ProximityReport {
  assertComparable(northRefA, northRefB);

  const threshold = options.thresholdMetres ?? null;
  if (threshold !== null && (!Number.isFinite(threshold) || threshold < 0)) {
    throw new AppError("VALIDATION", "threshold must be a non-negative finite number of metres");
  }

  let best: ProximityBreach | null = null;
  const breaches: ProximityBreach[] = [];

  for (let i = 0; i < a.points.length - 1; i++) {
    for (let j = 0; j < b.points.length - 1; j++) {
      const r = segmentSegmentDistance(
        { a: a.points[i]!, b: a.points[i + 1]! },
        { a: b.points[j]!, b: b.points[j + 1]! },
      );
      const breach: ProximityBreach = {
        segmentIndexA: i,
        segmentIndexB: j,
        distance: r.distance,
        pointA: r.p1,
        pointB: r.p2,
      };
      if (!best || r.distance < best.distance) best = breach;
      if (threshold !== null && r.distance <= threshold) breaches.push(breach);
    }
  }

  if (!best) {
    throw new AppError("VALIDATION", "could not compute proximity: empty trajectory");
  }

  const bound = approximationBound(a, b);

  return {
    minimumDistance: best.distance,
    thresholdMetres: threshold,
    warning: threshold !== null && best.distance <= threshold,
    closest: best,
    breaches,
    northRef: northRefA,
    approximationBoundMetres: bound,
  };
}

/**
 * Conservative bound: a segment deviates from the true arc by no more than
 * roughly half its chord length in the worst case; the closest-point error of
 * the pair is bounded by the sum of the two participating segment bounds.
 * We expose the sum of the two maximum half-chord lengths as a simple budget.
 */
export function approximationBound(a: Polyline, b: Polyline): number {
  return maxHalfChord(a) + maxHalfChord(b);
}

function maxHalfChord(p: Polyline): number {
  let m = 0;
  for (let i = 0; i < p.points.length - 1; i++) {
    const d = sub(p.points[i + 1]!, p.points[i]!);
    const len = Math.hypot(d.n, d.e, d.z);
    if (len / 2 > m) m = len / 2;
  }
  return m;
}
