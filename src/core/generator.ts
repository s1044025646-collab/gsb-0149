/**
 * Synthetic survey generator for demos and tests. Produces deterministic
 * output when a seeded PRNG is supplied; no real field data is used.
 */

import type { StationInput } from "../db/repository.js";

export interface Rng {
  next(): number;
}

/** Mulberry32 — small deterministic seeded PRNG. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next() {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

export interface GeneratorProfile {
  /** Station spacing in the output length unit. */
  spacing: number;
  /** Total measured length. */
  totalLength: number;
  /** Initial measured depth of the first station. */
  startMd?: number;
  noiseDeg?: number;
  rng?: Rng;
}

function wrapAz(v: number): number {
  return ((v % 360) + 360) % 360;
}

function build(
  profile: GeneratorProfile,
  angleAt: (fraction: number, index: number) => { inc: number; azi: number },
): StationInput[] {
  const start = profile.startMd ?? 0;
  const count = Math.round(profile.totalLength / profile.spacing);
  const rng = profile.rng ?? seededRng(1);
  const noise = profile.noiseDeg ?? 0;
  const stations: StationInput[] = [];
  for (let i = 0; i <= count; i++) {
    const f = count === 0 ? 0 : i / count;
    const a = angleAt(f, i);
    stations.push({
      md: start + i * profile.spacing,
      inc: clampAngle(a.inc + (noise ? (rng.next() - 0.5) * 2 * noise : 0), 0, 180),
      azi: wrapAz(a.azi + (noise ? (rng.next() - 0.5) * 2 * noise : 0)),
    });
  }
  return stations;
}

function clampAngle(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

/** Vertical well: inclination zero, azimuth convention 0. */
export function verticalWell(p: GeneratorProfile): StationInput[] {
  return build(p, () => ({ inc: 0, azi: 0 }));
}

/** Constant-inclination straight tangent. */
export function straightInclined(
  p: GeneratorProfile,
  inclinationDeg: number,
  azimuthDeg: number,
): StationInput[] {
  return build(p, () => ({ inc: inclinationDeg, azi: azimuthDeg }));
}

/**
 * Build-up arc: inclination ramps linearly from inc0 to inc1 while azimuth
 * ramps along the short way (may cross zero).
 */
export function buildArc(
  p: GeneratorProfile,
  inc0: number,
  inc1: number,
  azi0: number,
  azi1: number,
): StationInput[] {
  let aziDelta = (azi1 - azi0) % 360;
  if (aziDelta > 180) aziDelta -= 360;
  if (aziDelta < -180) aziDelta += 360;
  return build(p, (f) => ({
    inc: inc0 + (inc1 - inc0) * f,
    azi: wrapAz(azi0 + aziDelta * f),
  }));
}

/**
 * Traverse designed to cross azimuth zero: azimuth sweeps 357 -> 3 deg,
 * i.e. a 6 deg turn through north, never the 354 deg long arc.
 */
export function crossZeroWell(p: GeneratorProfile, inclinationDeg = 30): StationInput[] {
  return buildArc(p, inclinationDeg, inclinationDeg, 357, 3);
}

/** Long course followed by a very short course — exercises spacing edge cases. */
export function mixedSpacing(
  p: GeneratorProfile & { longSpacing: number; shortSpacing: number },
  inclinationDeg = 20,
  azimuthDeg = 45,
): StationInput[] {
  const out: StationInput[] = [];
  let md = p.startMd ?? 0;
  out.push({ md, inc: inclinationDeg, azi: azimuthDeg });
  md += p.longSpacing;
  out.push({ md, inc: inclinationDeg, azi: azimuthDeg });
  md += p.shortSpacing;
  out.push({ md, inc: inclinationDeg, azi: azimuthDeg });
  md += p.longSpacing;
  out.push({ md, inc: inclinationDeg, azi: azimuthDeg });
  return out;
}
