import { AppError } from "../core/errors.js";
import { isLengthUnit, isNorthRef, type LengthUnit, type NorthRef } from "../core/units.js";

export function requireObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new AppError("BAD_REQUEST", "request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

export function str(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new AppError("VALIDATION", `field '${key}' must be a non-empty string`, { field: key });
  }
  return v;
}

export function optionalStr(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw new AppError("VALIDATION", `field '${key}' must be a string`, { field: key });
  }
  return v;
}

export function num(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new AppError("VALIDATION", `field '${key}' must be a finite number`, { field: key });
  }
  return v;
}

export function optionalNum(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new AppError("VALIDATION", `field '${key}' must be a finite number`, { field: key });
  }
  return v;
}

export function northRef(obj: Record<string, unknown>, key = "northRef"): NorthRef {
  const v = obj[key];
  if (!isNorthRef(v)) {
    throw new AppError("VALIDATION", `field '${key}' must be one of true|grid|mag`, { field: key });
  }
  return v;
}

export function lengthUnit(obj: Record<string, unknown>, key = "lengthUnit"): LengthUnit {
  const v = obj[key];
  if (!isLengthUnit(v)) {
    throw new AppError("VALIDATION", `field '${key}' must be one of m|ft`, { field: key });
  }
  return v;
}

export interface Page {
  limit: number;
  offset: number;
}

export function pagination(search: URLSearchParams): Page {
  const limitRaw = search.get("limit");
  const offsetRaw = search.get("offset");
  const limit = limitRaw === null ? 50 : Number(limitRaw);
  const offset = offsetRaw === null ? 0 : Number(offsetRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new AppError("VALIDATION", "limit must be an integer in [1,500]");
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new AppError("VALIDATION", "offset must be a non-negative integer");
  }
  return { limit, offset };
}

export function stationsArray(obj: Record<string, unknown>) {
  const v = obj.stations;
  if (!Array.isArray(v) || v.length === 0) {
    throw new AppError("VALIDATION", "field 'stations' must be a non-empty array");
  }
  return v.map((raw, i) => {
    if (typeof raw !== "object" || raw === null) {
      throw new AppError("VALIDATION", `station[${i}] must be an object`);
    }
    const s = raw as Record<string, unknown>;
    const md = num(s, "md");
    const inc = num(s, "inc");
    const azi = num(s, "azi");
    if (md < 0) throw new AppError("VALIDATION", `station[${i}].md must be >= 0`);
    const clientId = optionalStr(s, "clientId");
    return { md, inc, azi, clientId: clientId ?? null };
  });
}
