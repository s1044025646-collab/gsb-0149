/**
 * Angle conventions used throughout this project:
 *
 *  - Inclination is measured FROM VERTICAL (0 = straight down along the wellbore,
 *    90 deg = horizontal, 180 deg = straight up). Range [0, 180].
 *  - Azimuth is the CLOCKWISE angle in the horizontal plane, 0 = north,
 *    90 = east, 180 = south, 270 = west. Range [0, 360).
 *  - TVD (true vertical depth) is POSITIVE DOWNWARD.
 *
 * Coordinate frame: x = north, y = east, z = tvd (down).
 * All computations are in a LOCAL PLANE frame; no map projection or
 * curvature-of-earth correction is applied.
 */

import { AppError } from "./errors.js";

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export interface Vec3 {
  n: number;
  e: number;
  z: number;
}

export function vec(n: number, e: number, z: number): Vec3 {
  return { n, e, z };
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { n: a.n + b.n, e: a.e + b.e, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { n: a.n - b.n, e: a.e - b.e, z: a.z - b.z };
}

export function scale(a: Vec3, s: number): Vec3 {
  return { n: a.n * s, e: a.e * s, z: a.z * s };
}
export function dot(a: Vec3, b: Vec3): number {
  return a.n * b.n + a.e * b.e + a.z * b.z;
}

export function norm(a: Vec3): number {
  return Math.hypot(a.n, a.e, a.z);
}

/**
 * Signed smallest azimuth difference a - b wrapped to (-180, 180].
 * Crossing zero (e.g. 359 -> 1) yields +2 deg, never the 358 deg long way.
 */
export function azimuthDelta(aDeg: number, bDeg: number): number {
  let d = (aDeg - bDeg) % 360;
  if (d <= -180) d += 360;
  if (d > 180) d -= 360;
  return d;
}

/**
 * Unit tangent along a wellbore from inclination/azimuth.
 * Inclination 0 points straight down (+z). Horizontal component magnitude
 * is sin(inclination), split into north/east by the clockwise azimuth.
 */
export function direction(inclinationDeg: number, azimuthDeg: number): Vec3 {
  const inc = inclinationDeg * DEG2RAD;
  const az = azimuthDeg * DEG2RAD;
  const h = Math.sin(inc);
  return {
    n: h * Math.cos(az),
    e: h * Math.sin(az),
    z: Math.cos(inc),
  };
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Validate a single (inclination, azimuth) pair.
 * Throws INVALID_ANGLE with a precise reason.
 */
export function validateAngles(inclinationDeg: number, azimuthDeg: number): void {
  if (!Number.isFinite(inclinationDeg) || !Number.isFinite(azimuthDeg)) {
    throw new AppError("INVALID_ANGLE", "inclination and azimuth must be finite numbers", {
      inclination: inclinationDeg,
      azimuth: azimuthDeg,
    });
  }
  if (inclinationDeg < 0 || inclinationDeg > 180) {
    throw new AppError("INVALID_ANGLE", "inclination must be within [0, 180] degrees (0 = vertical)", {
      inclination: inclinationDeg,
    });
  }
  if (azimuthDeg < 0 || azimuthDeg >= 360) {
    throw new AppError("INVALID_ANGLE", "azimuth must be within [0, 360) degrees, clockwise from north", {
      azimuth: azimuthDeg,
    });
  }
}
