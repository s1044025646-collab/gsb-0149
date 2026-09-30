/**
 * Core directional-survey geometry.
 *
 * Conventions (see README "Coordinate & angle conventions"):
 *  - Inclination is measured from vertical: 0 deg = straight down, 90 deg = horizontal.
 *  - Azimuth is measured clockwise in the horizontal plane, starting at the
 *    declared north reference: 0 deg = north, 90 deg = east.
 *  - Measured depth (MD) increases along the borehole and must be strictly increasing.
 *  - Local plane coordinates: north (N), east (E) and true vertical depth (TVD),
 *    where TVD is positive downward.
 *  - All internal lengths are expressed in metres.
 *
 * The minimum curvature method integrates each survey interval as a circular arc
 * whose tangent is the unit vector at the two bounding stations.
 */

export const DEG = Math.PI / 180;

/** Near-antiparallel tangents make the minimum-curvature ratio factor blow up. */
export const MAX_DOGLEG_DEG = 175;

export type LengthUnit = 'm' | 'ft';

/** Feet <-> metres (international foot). */
export const UNIT_TO_M: Record<LengthUnit, number> = {
  m: 1,
  ft: 0.3048,
};

export interface StationInput {
  /** Measured depth along the borehole, in `unit`. */
  md: number;
  /** Inclination from vertical, degrees, range [0,180]. */
  inc: number;
  /** Azimuth clockwise from north, degrees. */
  azi: number;
}

export interface SegmentResult {
  index: number;
  mdFrom: number;
  mdTo: number;
  dMd: number;
  /** Arc dog-leg angle between the two tangents, degrees in [0,180]. */
  doglegDeg: number;
  /** Dog-leg severity, degrees per 30 m of drilled length. */
  dlsDegPer30m: number;
  dN: number;
  dE: number;
  dTVD: number;
  /** Ratio factor 2 * tan(beta/2) / beta, with a stable limit of 1 for straight arcs. */
  ratioFactor: number;
}

/**
 * Unit direction (tangent) vector in (north, east, tvd-down) coordinates.
 */
export function tangent(incDeg: number, aziDeg: number): { n: number; e: number; v: number } {
  const inc = incDeg * DEG;
  // Normalize azimuth to [0, 360); wrap across zero is handled by trig directly.
  const azi = (((aziDeg % 360) + 360) % 360) * DEG;
  return {
    n: Math.sin(inc) * Math.cos(azi),
    e: Math.sin(inc) * Math.sin(azi),
    v: Math.cos(inc), // positive downward
  };
}

/**
 * Smallest unsigned angle (degrees, [0,180]) between two unit tangents.
 * Uses atan2(|a x b|, a . b) so it is numerically stable and never takes the
 * "long way" around — azimuth wrap across 0 is irrelevant here.
 */
export function angleBetween(
  a: { n: number; e: number; v: number },
  b: { n: number; e: number; v: number },
): number {
  const dot = a.n * b.n + a.e * b.e + a.v * b.v;
  const cx = a.e * b.v - a.v * b.e;
  const cy = a.v * b.n - a.n * b.v;
  const cz = a.n * b.e - a.e * b.n;
  const cross = Math.sqrt(cx * cx + cy * cy + cz * cz);
  const rad = Math.atan2(cross, Math.max(-1, Math.min(1, dot)));
  return rad / DEG;
}

/**
 * Stable minimum-curvature ratio factor f(beta) = 2 tan(beta/2) / beta.
 * For beta -> 0 the limit is exactly 1 (straight section).
 */
export function ratioFactor(betaRad: number): number {
  if (betaRad < 1e-9) return 1;
  return (2 * Math.tan(betaRad / 2)) / betaRad;
}

export class SurveyError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SurveyError';
    this.code = code;
  }
}

/**
 * Validate a single station's angles. Returns the canonical azimuth [0,360).
 */
export function validateAngles(inc: number, azi: number): { inc: number; azi: number } {
  if (!Number.isFinite(inc) || !Number.isFinite(azi)) {
    throw new SurveyError('INVALID_ANGLE', 'Inclination and azimuth must be finite numbers.');
  }
  if (inc < 0 || inc > 180) {
    throw new SurveyError('INVALID_ANGLE', `Inclination ${inc} out of range [0,180] degrees.`);
  }
  return { inc, azi: ((azi % 360) + 360) % 360 };
}

/**
 * Compute all minimum-curvature segments from an ordered list of stations.
 * Input MDs are expressed in metres (caller converts units beforehand).
 */
export function computeSegments(stationsM: StationInput[]): SegmentResult[] {
  if (stationsM.length === 0) {
    throw new SurveyError('NO_STATIONS', 'At least one survey station is required.');
  }
  const canonical = stationsM.map((s) => {
    const a = validateAngles(s.inc, s.azi);
    return { md: s.md, inc: a.inc, azi: a.azi };
  });

  for (let i = 1; i < canonical.length; i++) {
    if (!(canonical[i].md > canonical[i - 1].md)) {
      throw new SurveyError(
        'MD_NOT_STRICTLY_INCREASING',
        `Measured depth must be strictly increasing at station ${i} ` +
          `(${canonical[i - 1].md} -> ${canonical[i].md}).`,
      );
    }
  }

  const tangents = canonical.map((s) => tangent(s.inc, s.azi));
  const segments: SegmentResult[] = [];

  for (let i = 1; i < canonical.length; i++) {
    const p = canonical[i - 1];
    const q = canonical[i];
    const dMd = q.md - p.md;
    const dogleg = angleBetween(tangents[i - 1], tangents[i]);

    if (dogleg > MAX_DOGLEG_DEG) {
      throw new SurveyError(
        'NEAR_REVERSE_TANGENT',
        `Interval ${i - 1}-${i} has dog-leg ${dogleg.toFixed(2)} deg > ${MAX_DOGLEG_DEG}; ` +
          'near-opposite tangents are not integrated by minimum curvature.',
      );
    }

    const beta = dogleg * DEG;
    const rf = ratioFactor(beta);
    const a = tangents[i - 1];
    const b = tangents[i];
    // Minimum curvature displacement over the interval.
    const dN = (dMd / 2) * (a.n + b.n) * rf;
    const dE = (dMd / 2) * (a.e + b.e) * rf;
    const dTVD = (dMd / 2) * (a.v + b.v) * rf;

    segments.push({
      index: i - 1,
      mdFrom: p.md,
      mdTo: q.md,
      dMd,
      doglegDeg: dogleg,
      dlsDegPer30m: dMd > 0 ? (dogleg / dMd) * 30 : 0,
      dN,
      dE,
      dTVD,
      ratioFactor: rf,
    });
  }
  return segments;
}

export interface TrajectoryPoint {
  md: number;
  n: number;
  e: number;
  tvd: number;
  inc: number;
  azi: number;
}

/**
 * Rebuild the polyline of trajectory stations (metres) starting at the wellhead.
 * Wellhead tie-in (n0, e0, tvd0) is added afterwards; this function returns the
 * borehole-relative path beginning at (0,0,0).
 */
export function rebuildTrajectory(stationsM: StationInput[]): TrajectoryPoint[] {
  const segs = computeSegments(stationsM);
  const pts: TrajectoryPoint[] = [];
  const first = stationsM[0];
  const a0 = validateAngles(first.inc, first.azi);
  let n = 0;
  let e = 0;
  let tvd = 0;
  pts.push({ md: first.md, n, e, tvd, inc: a0.inc, azi: a0.azi });
  for (const s of segs) {
    n += s.dN;
    e += s.dE;
    tvd += s.dTVD;
    const st = stationsM[s.index + 1];
    const av = validateAngles(st.inc, st.azi);
    pts.push({ md: s.mdTo, n, e, tvd, inc: av.inc, azi: av.azi });
  }
  return pts;
}

export interface Vec3 {
  n: number;
  e: number;
  v: number;
}

/**
 * Minimum Euclidean distance between two finite 3-D line segments P1P2 and Q1Q2.
 * Classic segment-segment closest-point solution (Ericson, Real-Time Collision
 * Detection). Degenerate (zero-length) segments are handled by clamping.
 */
export function segmentSegmentDistance(p1: Vec3, p2: Vec3, q1: Vec3, q2: Vec3): number {
  const d1 = sub(p2, p1); // segment P direction
  const d2 = sub(q2, q1); // segment Q direction
  const r = sub(p1, q1);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);

  let s: number;
  let t: number;

  if (a <= 1e-15 && e <= 1e-15) {
    return Math.sqrt(dot(sub(p1, q1), sub(p1, q1)));
  }
  if (a <= 1e-15) {
    s = 0;
    t = clamp01(f / e);
  } else {
    const c = dot(d1, r);
    if (e <= 1e-15) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      if (Math.abs(denom) > 1e-12 * Math.max(1, a * e)) {
        s = clamp01((b * f - c * e) / denom);
        t = (b * s + f) / e;
        if (t < 0) {
          t = 0;
          s = clamp01(-c / a);
        } else if (t > 1) {
          t = 1;
          s = clamp01((b - c) / a);
        }
      } else {
        // Parallel (or anti-parallel) segments. Parametrize along the unit
        // direction of P; the separating vector is constant in direction, so
        // evaluate candidate endpoint projections on both segments.
        const dirNorm = Math.sqrt(a);
        const unit = { n: d1.n / dirNorm, e: d1.e / dirNorm, v: d1.v / dirNorm };
        // Q endpoints projected onto P line (as P parameter s):
        const proj = (q: Vec3) => clamp01(dot(sub(q, p1), unit) / dirNorm);
        const sCandidates = [0, 1, proj(q1), proj(q2)];
        // P endpoints projected onto Q:
        const projQ = (p: Vec3) =>
          clamp01(dot(sub(p, q1), { n: d2.n / Math.sqrt(e), e: d2.e / Math.sqrt(e), v: d2.v / Math.sqrt(e) }) / Math.sqrt(e));
        const tCandidates = [0, 1, projQ(p1), projQ(p2)];
        let bestD = Infinity;
        s = 0;
        t = 0;
        for (const sc of sCandidates) {
          const tc = clamp01((dot(d1, d2) * sc - dot(d1, r)) / e);
          const pp = { n: p1.n + d1.n * sc, e: p1.e + d1.e * sc, v: p1.v + d1.v * sc };
          const qq = { n: q1.n + d2.n * tc, e: q1.e + d2.e * tc, v: q1.v + d2.v * tc };
          const dd = dot(sub(pp, qq), sub(pp, qq));
          if (dd < bestD) {
            bestD = dd;
            s = sc;
            t = tc;
          }
        }
        for (const tc of tCandidates) {
          const sc = clamp01((dot(d1, r) + dot(d1, d2) * tc) / a);
          const pp = { n: p1.n + d1.n * sc, e: p1.e + d1.e * sc, v: p1.v + d1.v * sc };
          const qq = { n: q1.n + d2.n * tc, e: q1.e + d2.e * tc, v: q1.v + d2.v * tc };
          const dd = dot(sub(pp, qq), sub(pp, qq));
          if (dd < bestD) {
            bestD = dd;
            s = sc;
            t = tc;
          }
        }
      }
    }
  }

  const cP = {
    n: p1.n + d1.n * s,
    e: p1.e + d1.e * s,
    v: p1.v + d1.v * s,
  };
  const cQ = {
    n: q1.n + d2.n * t,
    e: q1.e + d2.e * t,
    v: q1.v + d2.v * t,
  };
  return Math.sqrt(dot(sub(cP, cQ), sub(cP, cQ)));
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return { n: a.n - b.n, e: a.e - b.e, v: a.v - b.v };
}
function dot(a: Vec3, b: Vec3): number {
  return a.n * b.n + a.e * b.e + a.v * b.v;
}
function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/**
 * Linear interpolation of a rebuilt trajectory at an arbitrary measured depth.
 * MD must lie within the covered range; endpoints are returned exactly.
 */
export function interpolateAtMd(points: TrajectoryPoint[], md: number): TrajectoryPoint {
  if (points.length === 0) throw new SurveyError('NO_STATIONS', 'Empty trajectory.');
  if (md < points[0].md - 1e-9 || md > points[points.length - 1].md + 1e-9) {
    throw new SurveyError(
      'MD_OUT_OF_RANGE',
      `MD ${md} is outside trajectory range [${points[0].md}, ${points[points.length - 1].md}].`,
    );
  }
  for (let i = 0; i < points.length - 1; i++) {
    const lo = points[i];
    const hi = points[i + 1];
    if (md >= lo.md - 1e-9 && md <= hi.md + 1e-9) {
      const span = hi.md - lo.md;
      const u = span === 0 ? 0 : (md - lo.md) / span;
      return {
        md,
        n: lo.n + (hi.n - lo.n) * u,
        e: lo.e + (hi.e - lo.e) * u,
        tvd: lo.tvd + (hi.tvd - lo.tvd) * u,
        inc: lo.inc + (hi.inc - lo.inc) * u,
        azi: interpolateAzi(lo.azi, hi.azi, u),
      };
    }
  }
  return points[points.length - 1];
}

/** Interpolate azimuth along the shortest arc, so 359 -> 1 crosses zero, not 358 deg. */
export function interpolateAzi(a0: number, a1: number, u: number): number {
  const delta = ((a1 - a0 + 540) % 360) - 180; // signed shortest delta in [-180,180)
  let v = a0 + delta * u;
  v = ((v % 360) + 360) % 360;
  return v;
}


