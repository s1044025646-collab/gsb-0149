/**
 * Length unit handling. Every numeric computation happens in metres ("m").
 * Survey imports carry an explicit unit; mixing units across a request is rejected.
 */

export const LENGTH_UNITS = ["m", "ft"] as const;
export type LengthUnit = (typeof LENGTH_UNITS)[number];

/** International foot, the standard surveying conversion. */
export const METRES_PER_FOOT = 0.3048;

export function isLengthUnit(value: unknown): value is LengthUnit {
  return value === "m" || value === "ft";
}

export function toMetres(value: number, unit: LengthUnit): number {
  return unit === "ft" ? value * METRES_PER_FOOT : value;
}

export function fromMetres(metres: number, unit: LengthUnit): number {
  return unit === "ft" ? metres / METRES_PER_FOOT : metres;
}

/**
 * Convert dogleg severity from internal degrees-per-30-metres to the
 * degrees-per-standard-interval of the given unit (30 m or 100 ft).
 */
export function dlsForUnit(dlsPer30m: number, unit: LengthUnit): number {
  // deg per 30 m -> deg per m, then -> deg per 100 ft.
  return unit === "ft" ? (dlsPer30m / 30) * (100 * METRES_PER_FOOT) : dlsPer30m;
}

/**
 * North references. Azimuth values are meaningless without an explicit reference
 * and convention, so two trajectories with different references may never be
 * compared directly.
 *
 *  - true  : azimuth measured clockwise from true (geographic) north
 *  - grid  : azimuth measured clockwise from grid north of the local plane
 *  - mag   : azimuth measured clockwise from magnetic north (no declination model here)
 */
export const NORTH_REFS = ["true", "grid", "mag"] as const;
export type NorthRef = (typeof NORTH_REFS)[number];

export function isNorthRef(value: unknown): value is NorthRef {
  return value === "true" || value === "grid" || value === "mag";
}
