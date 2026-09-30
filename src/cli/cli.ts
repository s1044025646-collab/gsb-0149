#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase } from "../db/database.js";
import { Repository, type StationInput } from "../db/repository.js";
import { TrajectoryService } from "../core/service.js";
import { AppError } from "../core/errors.js";
import { dlsForUnit, fromMetres } from "../core/units.js";

function dbPath(): string {
  return process.env.BOREHOLE_DB ?? resolve("data", "borehole.sqlite");
}

function parseArgs(argv: string[]): { command: string; flags: Map<string, string> } {
  const [command, ...rest] = argv;
  if (!command) usageAndExit();
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, "true");
      }
    }
  }
  return { command, flags };
}

function usageAndExit(never?: never): never {
  console.error(
    [
      "Usage: borehole <command> [flags]",
      "",
      "Commands:",
      "  create-well  --id W --name N --north-ref true|grid|mag --unit m|ft --head-north 0 --head-east 0",
      "  import       --well W --file stations.json|stations.csv [--reason text] [--idempotency-key K]",
      "  trajectory   --well W [--version V]",
      "  position     --well W --md 123.4 [--version V]",
      "  max-dogleg   --well W [--version V]",
      "  compare      --well-a A --well-b B [--threshold 10] [--threshold-unit m|ft] [--version-a N] [--version-b N]",
      "  export-increments --well W [--version V] [--out courses.csv]",
      "  list-wells",
      "",
      "Environment: BOREHOLE_DB overrides the database path (default ./data/borehole.sqlite).",
    ].join("\n"),
  );
  process.exit(never === undefined ? 1 : 1);
}

function f(flags: Map<string, string>, key: string): string {
  const v = flags.get(key);
  if (v === undefined) throw new AppError("BAD_REQUEST", `missing required flag --${key}`);
  return v;
}

function opt(flags: Map<string, string>, key: string): string | undefined {
  return flags.get(key);
}

function loadStations(file: string): StationInput[] {
  const raw = readFileSync(file, "utf8");
  if (file.toLowerCase().endsWith(".csv")) {
    return parseCsv(raw);
  }
  const parsed = JSON.parse(raw) as unknown;
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as { stations?: unknown[] }).stations;
  if (!Array.isArray(list)) {
    throw new AppError("BAD_REQUEST", "JSON input must be an array or {stations:[...]}");
  }
  return list.map((row, i) => {
    const r = row as Record<string, unknown>;
    return {
      md: num(r, "md", i),
      inc: num(r, "inc", i),
      azi: num(r, "azi", i),
      clientId: typeof r.clientId === "string" ? r.clientId : null,
    };
  });
}

function num(r: Record<string, unknown>, key: string, i: number): number {
  const v = r[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new AppError("VALIDATION", `station[${i}].${key} must be a finite number`);
  }
  return v;
}

function parseCsv(raw: string): StationInput[] {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) throw new AppError("BAD_REQUEST", "CSV must include header and rows");
  const header = lines[0]!.split(",").map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const mdI = idx("md");
  const incI = idx("inc");
  const aziI = idx("azi");
  if (mdI < 0 || incI < 0 || aziI < 0) {
    throw new AppError("BAD_REQUEST", "CSV header must contain md,inc,azi");
  }
  const cidI = idx("clientid");
  return lines.slice(1).map((line, i) => {
    const cols = line.split(",").map((c) => c.trim());
    const md = Number(cols[mdI]);
    const inc = Number(cols[incI]);
    const azi = Number(cols[aziI]);
    if (![md, inc, azi].every(Number.isFinite)) {
      throw new AppError("VALIDATION", `CSV row ${i + 2} contains non-numeric values`);
    }
    return { md, inc, azi, clientId: cidI >= 0 ? cols[cidI] : null };
  });
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const keys = Object.keys(rows[0]!);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    keys.join(","),
    ...rows.map((r) => keys.map((k) => esc(r[k])).join(",")),
  ].join("\n");
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const path = dbPath();
  const db = openDatabase(path);
  const repo = new Repository(db);
  const service = new TrajectoryService(repo);

  const showWellState = (wellId: string, label: string) => {
    try {
      const well = repo.getWellByPublicId(wellId);
      const v = repo.getLatestVersion(well.id);
      console.log(
        `[state:${label}] well=${wellId} north=${well.north_ref} unit=${well.length_unit} ` +
          `latestVersion=${v ? v.version : "none"} stations=${v ? v.station_count : 0}`,
      );
    } catch {
      console.log(`[state:${label}] well=${wellId} not found`);
    }
  };

  try {
    switch (command) {
      case "create-well": {
        const id = f(flags, "id");
        const before = (() => {
          try {
            repo.getWellByPublicId(id);
            return true;
          } catch {
            return false;
          }
        })();
        console.log(`[before] well '${id}' exists=${before}`);
        const well = repo.createWell({
          publicId: id,
          name: f(flags, "name"),
          northRef: f(flags, "north-ref") as "true" | "grid" | "mag",
          lengthUnit: f(flags, "unit") as "m" | "ft",
          headNorth: Number(opt(flags, "head-north") ?? 0),
          headEast: Number(opt(flags, "head-east") ?? 0),
          headTvd: Number(opt(flags, "head-tvd") ?? 0),
        });
        console.log(`[after] created well id=${well.public_id} db=${path}`);
        break;
      }
      case "import": {
        const wellId = f(flags, "well");
        const file = f(flags, "file");
        const well = repo.getWellByPublicId(wellId);
        const stations = loadStations(file);
        const before = repo.getLatestVersion(well.id);
        console.log(
          `[before] well=${wellId} latestVersion=${before ? before.version : "none"} incomingStations=${stations.length}`,
        );
        const out = repo.addVersion(well, stations, opt(flags, "reason") ?? "import", {
          idempotencyKey: opt(flags, "idempotency-key") ?? null,
        });
        const after = repo.getLatestVersion(well.id);
        console.log(
          `[after] version=${out.version} reused=${out.reused} stations=${after?.station_count} mdRange=${after?.md_min.toFixed(3)}..${after?.md_max.toFixed(3)} ${well.length_unit}(stored in m)`,
        );
        break;
      }
      case "trajectory": {
        const wellId = f(flags, "well");
        const version = opt(flags, "version") ? Number(f(flags, "version")) : undefined;
        const rec = service.reconstruct(wellId, version);
        console.log(`well=${wellId} version=${rec.version} north=${rec.well.north_ref}`);
        for (const p of rec.result.points) {
          console.log(
            `md=${p.md.toFixed(3)} N=${p.n.toFixed(3)} E=${p.e.toFixed(3)} TVD=${p.z.toFixed(3)}` +
              ` | world N=${(rec.well.head_north + p.n).toFixed(3)} E=${(rec.well.head_east + p.e).toFixed(3)}`,
          );
        }
        break;
      }
      case "position": {
        const wellId = f(flags, "well");
        const md = Number(f(flags, "md"));
        const version = opt(flags, "version") ? Number(f(flags, "version")) : undefined;
        const out = service.queryAtMd(wellId, md, version);
        console.log(JSON.stringify(out, null, 2));
        break;
      }
      case "max-dogleg": {
        const wellId = f(flags, "well");
        const version = opt(flags, "version") ? Number(f(flags, "version")) : undefined;
        const out = service.maxDogleg(wellId, version);
        const dlsLabel = out.unit === "ft" ? "deg/100ft" : "deg/30m";
        const dlsValue =
          out.unit === "ft"
            ? dlsForUnit(out.course.dlsPer30m, "ft")
            : out.course.dlsPer30m;
        console.log(
          `well=${wellId} version=${out.version} maxDogleg=${out.course.doglegDeg.toFixed(4)} deg ` +
            `DLS=${dlsValue.toFixed(4)} ${dlsLabel} over md ${out.course.mdFrom.toFixed(3)}->${out.course.mdTo.toFixed(3)}`,
        );
        break;
      }
      case "compare": {
        const a = f(flags, "well-a");
        const b = f(flags, "well-b");
        const threshold = opt(flags, "threshold") ? Number(f(flags, "threshold")) : undefined;
        const out = service.compareWells(a, b, {
          versionA: opt(flags, "version-a") ? Number(f(flags, "version-a")) : undefined,
          versionB: opt(flags, "version-b") ? Number(f(flags, "version-b")) : undefined,
          threshold,
          thresholdUnit: (opt(flags, "threshold-unit") ?? "m") as "m" | "ft",
        });
        console.log(
          `[compare] ${a}(v${out.versionA}) vs ${b}(v${out.versionB}) minDistance=${out.minimumDistance.toFixed(4)} m ` +
            `warning=${out.warning} approxBound<=${out.approximationBoundMetres.toFixed(4)} m`,
        );
        console.log(
          `  closest segments A#${out.closest.segmentIndexA} B#${out.closest.segmentIndexB}`,
        );
        console.log(
          "  note: polyline approximation; threshold warning is not proof of safety and no probabilistic collision risk is provided.",
        );
        break;
      }
      case "export-increments": {
        const wellId = f(flags, "well");
        const version = opt(flags, "version") ? Number(f(flags, "version")) : undefined;
        const rec = service.reconstruct(wellId, version);
        const u = rec.well.length_unit;
        const rows = rec.result.courses.map((c) => ({
          seq: c.fromIndex,
          mdFrom: fromMetres(c.mdFrom, u).toFixed(6),
          mdTo: fromMetres(c.mdTo, u).toFixed(6),
          length: fromMetres(c.length, u).toFixed(6),
          doglegDeg: c.doglegDeg.toFixed(6),
          [u === "ft" ? "dlsPer100ft" : "dlsPer30m"]: dlsForUnit(c.dlsPer30m, u).toFixed(6),
          deltaNorth: c.deltaN.toFixed(6),
          deltaEast: c.deltaE.toFixed(6),
          deltaTvd: c.deltaTvd.toFixed(6),
          totalNorth: c.totalN.toFixed(6),
          totalEast: c.totalE.toFixed(6),
          totalTvd: c.totalTvd.toFixed(6),
        }));
        const csv = toCsv(rows);
        const outFile = opt(flags, "out");
        if (outFile) {
          writeFileSync(outFile, csv + "\n", "utf8");
          console.log(`[export] wrote ${rows.length} courses to ${outFile} (lengths in ${u})`);
        } else {
          console.log(csv);
        }
        break;
      }
      case "list-wells": {
        const { rows, total } = repo.listWells(500, 0);
        console.log(`wells total=${total}`);
        for (const w of rows) {
          const v = repo.getLatestVersion(w.id);
          console.log(
            `  ${w.public_id} name="${w.name}" north=${w.north_ref} unit=${w.length_unit} versions=${v ? v.version : 0}`,
          );
        }
        break;
      }
      default:
        usageAndExit();
    }
  } catch (err) {
    if (err instanceof AppError) {
      console.error(`error [${err.code}] ${err.message}`);
      if (err.details !== undefined) console.error(JSON.stringify(err.details));
      process.exitCode = 1;
    } else {
      throw err;
    }
  } finally {
    db.close();
  }
}

main();
