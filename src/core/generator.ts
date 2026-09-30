import { type LengthUnit, type StationInput, UNIT_TO_M } from './geometry.ts';

/**
 * Fictional survey data generator. Produces purely synthetic stations for
 * demos/tests. No real drilling data is involved. Deterministic given a seed
 * (mulberry32) so end-to-end demos and tests are repeatable; an RNG and clock may
 * be injected.
 */

export interface GenerateOptions {
  /** Number of survey stations. */
  stations?: number;
  /** Station spacing in `unit`. */
  spacing?: number;
  /** Starting measured depth in `unit`. */
  startMd?: number;
  /** Initial inclination (deg from vertical). */
  startInc?: number;
  /** Constant build rate, deg per 30 m. */
  buildRate?: number;
  /** Initial azimuth, degrees clockwise from north. */
  startAzi?: number;
  /** Azimuth walk rate, deg per 30 m. */
  walkRate?: number;
  unit?: LengthUnit;
  /** Random seed. */
  seed?: number;
  /** Additive noise standard deviation, degrees (applied to inc & azi). */
  noiseDeg?: number;
}

/** Deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller normal sample from a uniform source. */
function gaussian(rand: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function generateSurvey(opts: GenerateOptions = {}): StationInput[] {
  const count = opts.stations ?? 21;
  const spacing = opts.spacing ?? 30;
  const startMd = opts.startMd ?? 0;
  const inc0 = opts.startInc ?? 0;
  const build = opts.buildRate ?? 2;
  const azi0 = opts.startAzi ?? 0;
  const walk = opts.walkRate ?? 0;
  const unit: LengthUnit = opts.unit ?? 'm';
  const seed = opts.seed ?? 12345;
  const noise = opts.noiseDeg ?? 0;
  const rand = mulberry32(seed);

  const stepM = spacing * UNIT_TO_M[unit];
  const out: StationInput[] = [];
  for (let i = 0; i < count; i++) {
    const md = startMd + i * spacing;
    const mdM = i * stepM;
    let inc = inc0 + (build * mdM) / 30 + (noise ? gaussian(rand) * noise : 0);
    let azi = azi0 + (walk * mdM) / 30 + (noise ? gaussian(rand) * noise : 0);
    inc = Math.max(0, Math.min(179.9, inc));
    out.push({ md, inc, azi: ((azi % 360) + 360) % 360 });
  }
  return out;
}

/** Built-in named synthetic well profiles used by the demo. */
export function presetProfile(name: string): GenerateOptions {
  switch (name) {
    case 'vertical':
      return { stations: 21, spacing: 30, startInc: 0, buildRate: 0, seed: 1 };
    case 'slant':
      return { stations: 21, spacing: 30, startInc: 30, buildRate: 0, startAzi: 45, seed: 2 };
    case 'build':
      return { stations: 31, spacing: 20, startInc: 0, buildRate: 3 };
    case 'crossing':
      return { stations: 21, spacing: 30, startInc: 20, buildRate: 0, startAzi: 90, seed: 4 };
    default:
      return { seed: 7 };
  }
}
