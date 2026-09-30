/**
 * Minimum curvature method (balanced tangential arc).
 *
 * For a course from survey A to survey B separated by measured-depth length L,
 * with unit tangents uA, uB and dogleg angle beta between them:
 *
 *   rB - rA = L * (uA + uB) / 2 * (2/beta) * tan(beta/2)
 *
 * The ratio factor f = (2/beta) tan(beta/2) tends smoothly to 1 as beta -> 0.
 * We use its stable Taylor expansion for small beta instead of dividing by a
 * tiny number, which keeps straight and near-straight sections exact-stable.
 *
 * Near-opposite tangents (beta close to 180 deg) make the minimum-curvature
 * arc ambiguous and the factor blow up; such courses are rejected.
 */

import { AppError } from "./errors.js";
import {
  DEG2RAD,
  RAD2DEG,
  type Vec3,
  add,
  clamp,
  direction,
  dot,
  norm,
  scale,
  validateAngles,
} from "./geometry.js";

/** Doglegs at or above this angle are treated as near-reverse and rejected. */
export const MAX_DOGLEG_RAD = Math.PI - 1e-6;

/** Below this dogleg angle (radians) the series form of the ratio is used. */
const SMALL_BETA = 0.1;

export interface SurveyStation {
  /** Measured depth along the wellbore, in metres, strictly increasing. */
  md: number;
  /** Inclination from vertical, degrees [0,180]. */
  inc: number;
  /** Azimuth clockwise from the declared north reference, degrees [0,360). */
  azi: number;
}

export interface CourseIncrement {
  fromIndex: number;
  toIndex: number;
  mdFrom: number;
  mdTo: number;
  length: number;
  /** Dogleg angle between the two tangents, degrees [0,180]. */
  doglegDeg: number;
  /** Dogleg severity in degrees per 30 m (and per 100 ft is derived elsewhere if needed). */
  dlsPer30m: number;
  deltaN: number;
  deltaE: number;
  deltaTvd: number;
  /** End-of-course cumulative values, in metres. */
  totalN: number;
  totalE: number;
  totalTvd: number;
}

export interface TrajectoryPoint extends Vec3 {
  md: number;
  inc: number;
  azi: number;
}

export interface TrajectoryResult {
  points: TrajectoryPoint[];
  courses: CourseIncrement[];
}

/**
 * Stable minimum-curvature ratio f(beta) = tan(beta/2) / (beta/2).
 * Series: 1 + beta^2/12 + beta^4/720 + ...
 */
export function curvatureRatio(beta: number): number {
  if (Math.abs(beta) < SMALL_BETA) {
    const b2 = beta * beta;
    return 1 + b2 / 12 + (b2 * b2) / 720;
  }
  return Math.tan(beta / 2) / (beta / 2);
}

/**
 * Dogleg angle between two survey directions, in radians [0, pi].
 * Computed via the unit tangents, so azimuth wrap at zero is handled
 * intrinsically (359 deg -> 1 deg is a 2 deg turn, not 358 deg).
 */
export function doglegAngle(a: SurveyStation, b: SurveyStation): number {
  const uA = direction(a.inc, a.azi);
  const uB = direction(b.inc, b.azi);
  const cosBeta = clamp(dot(uA, uB), -1, 1);
  return Math.acos(cosBeta);
}

/**
 * Build the full trajectory from an ordered list of survey stations.
 * The first station fixes the origin at (0,0,0); wellhead tie-in is applied
 * by the caller.
 */
export function computeTrajectory(stations: SurveyStation[]): TrajectoryResult {
  if (stations.length === 0) {
    throw new AppError("VALIDATION", "at least one survey station is required");
  }

  for (const s of stations) {
    if (!Number.isFinite(s.md) || s.md < 0) {
      throw new AppError("VALIDATION", "measured depth must be a finite non-negative number", { md: s.md });
    }
    validateAngles(s.inc, s.azi);
  }

  for (let i = 1; i < stations.length; i++) {
    if (!(stations[i]!.md > stations[i - 1]!.md)) {
      throw new AppError(
        "MD_NOT_STRICTLY_INCREASING",
        `measured depth must be strictly increasing: ${stations[i - 1]!.md} -> ${stations[i]!.md}`,
        { index: i, previousMd: stations[i - 1]!.md, md: stations[i]!.md },
      );
    }
  }

  const points: TrajectoryPoint[] = [];
  const courses: CourseIncrement[] = [];

  const first = stations[0]!;
  let n = 0;
  let e = 0;
  let tvd = 0;
  points.push({ md: first.md, inc: first.inc, azi: first.azi, n, e, z: tvd });

  for (let i = 1; i < stations.length; i++) {
    const a = stations[i - 1]!;
    const b = stations[i]!;
    const length = b.md - a.md;
    const uA = direction(a.inc, a.azi);
    const uB = direction(b.inc, b.azi);

    const cosBeta = clamp(dot(uA, uB), -1, 1);
    const beta = Math.acos(cosBeta);

    if (beta >= MAX_DOGLEG_RAD) {
      throw new AppError(
        "NEAR_OPPOSITE_TANGENT",
        `course ${i - 1}->${i} has nearly opposite tangents (dogleg ${(beta * RAD2DEG).toFixed(3)} deg); minimum curvature is undefined`,
        { index: i, doglegDeg: beta * RAD2DEG },
      );
    }

    const f = curvatureRatio(beta);
    const mid = scale(add(uA, uB), 0.5 * length * f);

    n += mid.n;
    e += mid.e;
    tvd += mid.z;

    const doglegDeg = beta * RAD2DEG;
    courses.push({
      fromIndex: i - 1,
      toIndex: i,
      mdFrom: a.md,
      mdTo: b.md,
      length,
      doglegDeg,
      dlsPer30m: length > 0 ? (doglegDeg * 30) / length : 0,
      deltaN: mid.n,
      deltaE: mid.e,
      deltaTvd: mid.z,
      totalN: n,
      totalE: e,
      totalTvd: tvd,
    });
    points.push({ md: b.md, inc: b.inc, azi: b.azi, n, e, z: tvd });
  }

  return { points, courses };
}

/**
 * Interpolate a trajectory at an arbitrary measured depth using the
 * minimum-curvature arc of the enclosing course. Returns null-equivalent
 * behaviour via throw when out of range (caller decides).
 *
 * Position within a course at arc fraction t = dL / L:
 * We reconstruct by re-running minimum curvature from the course start to a
 * synthetic intermediate tangent rotated along the great-circle arc. A simpler,
 * consistent choice matching our straight/arc model is to interpolate along the
 * same balanced arc:
 *   r(t) = r0 + L_t * f(t*beta) * tangent_at_fraction... — implemented via
 *   slerp of tangents and the curvature ratio, which reproduces the arc exactly.
 */
export function interpolateAtMd(
  result: TrajectoryResult,
  md: number,
): { point: TrajectoryPoint; courseIndex: number; fraction: number } {
  if (!Number.isFinite(md)) {
    throw new AppError("VALIDATION", "measured depth must be a finite number");
  }
  const first = result.points[0]!;
  const last = result.points[result.points.length - 1]!;
  if (md < first.md || md > last.md) {
    throw new AppError(
      "OUT_OF_RANGE",
      `measured depth ${md} is outside trajectory range [${first.md}, ${last.md}]`,
      { md, min: first.md, max: last.md },
    );
  }

  let courseIndex = 0;
  for (let i = 0; i < result.courses.length; i++) {
    const c = result.courses[i]!;
    if (md >= c.mdFrom && md < c.mdTo) {
      courseIndex = i;
      break;
    }
    // Final station closes the last course.
    if (i === result.courses.length - 1 && md === c.mdTo) courseIndex = i;
  }

  const c = result.courses[courseIndex]!;
  const start = result.points[c.fromIndex]!;
  const end = result.points[c.toIndex]!;

  if (md === c.mdFrom) {
    return { point: { ...start }, courseIndex, fraction: 0 };
  }
  if (md === c.mdTo) {
    return { point: { ...end }, courseIndex, fraction: 1 };
  }

  const frac = (md - c.mdFrom) / c.length;

  // Slerp the unit tangent along the great circle, then integrate using the
  // same curvature ratio so the interpolant lies on the minimum-curvature arc.
  const u0 = direction(start.inc, start.azi);
  const u1 = direction(end.inc, end.azi);
  const beta = c.doglegDeg * DEG2RAD;

  let tangentAt: Vec3;
  if (beta < 1e-9) {
    tangentAt = u0;
  } else {
    const s0 = Math.sin((1 - frac) * beta) / Math.sin(beta);
    const s1 = Math.sin(frac * beta) / Math.sin(beta);
    tangentAt = {
      n: u0.n * s0 + u1.n * s1,
      e: u0.e * s0 + u1.e * s1,
      z: u0.z * s0 + u1.z * s1,
    };
  }

  // Displacement from course start over arc length L_t.
  const lt = frac * c.length;
  const fSub = curvatureRatio(frac * beta);
  const subDisp = scale(add(u0, tangentAt), 0.5 * lt * fSub);

  const point: TrajectoryPoint = {
    md,
    inc: start.inc + (end.inc - start.inc) * frac,
    azi: interpolateAzimuth(start.azi, end.azi, frac),
    n: start.n + subDisp.n,
    e: start.e + subDisp.e,
    z: start.z + subDisp.z,
  };
  return { point, courseIndex, fraction: frac };
}

/**
 * Azimuth interpolation along the SHORT arc across zero.
 * 359 -> 1 at fraction 0.5 yields 0 (360), not 180.
 */
export function interpolateAzimuth(a0: number, a1: number, t: number): number {
  let delta = (a1 - a0) % 360;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  let v = a0 + delta * t;
  v = ((v % 360) + 360) % 360;
  return v;
}

/** Locate the course with the largest dogleg severity. */
export function maximumDogleg(result: TrajectoryResult): CourseIncrement | null {
  let best: CourseIncrement | null = null;
  for (const c of result.courses) {
    if (!best || c.doglegDeg > best.doglegDeg) best = c;
  }
  return best;
}
