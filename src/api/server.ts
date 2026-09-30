import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Db } from "../db/database.js";
import { Repository } from "../db/repository.js";
import { AppError, httpStatusFor } from "../core/errors.js";
import { TrajectoryService } from "../core/service.js";
import {
  lengthUnit,
  northRef,
  num,
  optionalNum,
  optionalStr,
  pagination,
  requireObject,
  stationsArray,
  str,
} from "./validation.js";
import { isLengthUnit } from "../core/units.js";

export interface AppContext {
  db: Db;
  repo: Repository;
  service: TrajectoryService;
}

export function defaultDbPath(): string {
  if (process.env.BOREHOLE_DB) return process.env.BOREHOLE_DB;
  return join(homedir(), ".borehole-trajectory", "data.sqlite");
}

export function createApp(db: Db): AppContext {
  const repo = new Repository(db);
  const service = new TrajectoryService(repo);
  return { db, repo, service };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
  });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 4 * 1024 * 1024) {
      throw new AppError("BAD_REQUEST", "request body too large (max 4 MiB)");
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("BAD_REQUEST", "request body is not valid JSON");
  }
}

function pageEnvelope<T>(rows: T[], total: number, limit: number, offset: number) {
  return {
    data: rows,
    pagination: {
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
    },
  };
}

export function requestHandler(ctx: AppContext) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (req.method === "GET" && path === "/health") {
        send(res, 200, { status: "ok" });
        return;
      }

      // Wells
      if (req.method === "POST" && path === "/wells") {
        const body = requireObject(await readJson(req));
        const well = ctx.repo.createWell({
          publicId: optionalStr(body, "id"),
          name: str(body, "name"),
          northRef: northRef(body),
          lengthUnit: lengthUnit(body),
          headNorth: num(body, "headNorth"),
          headEast: num(body, "headEast"),
          headTvd: optionalNum(body, "headTvd") ?? 0,
        });
        send(res, 201, { data: well });
        return;
      }
      if (req.method === "GET" && path === "/wells") {
        const { limit, offset } = pagination(url.searchParams);
        const { rows, total } = ctx.repo.listWells(limit, offset);
        send(res, 200, pageEnvelope(rows, total, limit, offset));
        return;
      }

      const wellMatch = path.match(/^\/wells\/([^/]+)$/);
      if (req.method === "GET" && wellMatch) {
        send(res, 200, { data: ctx.repo.getWellByPublicId(decodeURIComponent(wellMatch[1]!)) });
        return;
      }

      // Versions
      const versionsMatch = path.match(/^\/wells\/([^/]+)\/versions$/);
      if (req.method === "GET" && versionsMatch) {
        const well = ctx.repo.getWellByPublicId(decodeURIComponent(versionsMatch[1]!));
        const { limit, offset } = pagination(url.searchParams);
        const { rows, total } = ctx.repo.listVersions(well.id, limit, offset);
        send(res, 200, pageEnvelope(rows, total, limit, offset));
        return;
      }
      if (req.method === "POST" && versionsMatch) {
        const well = ctx.repo.getWellByPublicId(decodeURIComponent(versionsMatch[1]!));
        const body = requireObject(await readJson(req));
        const stations = stationsArray(body);
        const reason = str(body, "reason");
        const key = optionalStr(body, "idempotencyKey");
        const out = ctx.repo.addVersion(well, stations, reason, { idempotencyKey: key ?? null });
        send(res, out.reused ? 200 : 201, {
          data: { version: out.version, reused: out.reused },
        });
        return;
      }

      // Stations / courses of a version
      const stationsMatch = path.match(/^\/wells\/([^/]+)\/versions\/(\d+)\/stations$/);
      if (req.method === "GET" && stationsMatch) {
        const well = ctx.repo.getWellByPublicId(decodeURIComponent(stationsMatch[1]!));
        const v = ctx.repo.getVersion(well.id, Number(stationsMatch[2]));
        const { limit, offset } = pagination(url.searchParams);
        const { rows, total } = ctx.repo.getStations(v.id, limit, offset);
        send(res, 200, pageEnvelope(rows, total, limit, offset));
        return;
      }
      const coursesMatch = path.match(/^\/wells\/([^/]+)\/versions\/(\d+)\/courses$/);
      if (req.method === "GET" && coursesMatch) {
        const well = ctx.repo.getWellByPublicId(decodeURIComponent(coursesMatch[1]!));
        const v = ctx.repo.getVersion(well.id, Number(coursesMatch[2]));
        const { limit, offset } = pagination(url.searchParams);
        const { rows, total } = ctx.repo.getCourses(v.id, limit, offset);
        send(res, 200, pageEnvelope(rows, total, limit, offset));
        return;
      }

      // Trajectory (reconstructed, relative + world points)
      const trajMatch = path.match(/^\/wells\/([^/]+)\/trajectory$/);
      if (req.method === "GET" && trajMatch) {
        const versionParam = url.searchParams.get("version");
        const rec = ctx.service.reconstruct(
          decodeURIComponent(trajMatch[1]!),
          versionParam === null ? undefined : Number(versionParam),
        );
        send(res, 200, {
          data: {
            well: trajMatch[1],
            version: rec.version,
            northRef: rec.well.north_ref,
            unit: rec.well.length_unit,
            points: rec.result.points,
            worldPoints: rec.world,
          },
        });
        return;
      }

      // Position query
      const posMatch = path.match(/^\/wells\/([^/]+)\/position$/);
      if (req.method === "GET" && posMatch) {
        const mdRaw = url.searchParams.get("md");
        if (mdRaw === null) throw new AppError("VALIDATION", "query parameter 'md' is required");
        const md = Number(mdRaw);
        const vp = url.searchParams.get("version");
        const out = ctx.service.queryAtMd(
          decodeURIComponent(posMatch[1]!),
          md,
          vp === null ? undefined : Number(vp),
        );
        send(res, 200, { data: out });
        return;
      }

      // Max dogleg
      const dlsMatch = path.match(/^\/wells\/([^/]+)\/max-dogleg$/);
      if (req.method === "GET" && dlsMatch) {
        const vp = url.searchParams.get("version");
        const out = ctx.service.maxDogleg(
          decodeURIComponent(dlsMatch[1]!),
          vp === null ? undefined : Number(vp),
        );
        send(res, 200, { data: out });
        return;
      }

      // Well comparison
      if (req.method === "POST" && path === "/comparisons") {
        const body = requireObject(await readJson(req));
        const thresholdUnitRaw = optionalStr(body, "thresholdUnit") ?? "m";
        if (!isLengthUnit(thresholdUnitRaw)) {
          throw new AppError("VALIDATION", "thresholdUnit must be one of m|ft");
        }
        const out = ctx.service.compareWells(str(body, "wellA"), str(body, "wellB"), {
          versionA: optionalNum(body, "versionA"),
          versionB: optionalNum(body, "versionB"),
          threshold: optionalNum(body, "threshold"),
          thresholdUnit: thresholdUnitRaw,
          reportId: optionalStr(body, "id"),
        });
        send(res, 201, {
          data: out,
          caveats: {
            polylineApproximation:
              "distance is computed between reconstructed segments; the true continuous wellbores may be slightly closer (see approximationBoundMetres).",
            noProbabilisticRisk:
              "no error-ellipsoid model is present; a threshold warning is NOT a probability of collision and is not proof of safety.",
          },
        });
        return;
      }

      if (req.method === "GET" && path === "/reports") {
        const { limit, offset } = pagination(url.searchParams);
        const { rows, total } = ctx.repo.listReports(limit, offset);
        send(res, 200, pageEnvelope(rows, total, limit, offset));
        return;
      }

      send(res, 404, { error: { code: "NOT_FOUND", message: `no route for ${req.method} ${path}` } });
    } catch (err) {
      if (err instanceof AppError) {
        send(res, httpStatusFor(err.code), {
          error: { code: err.code, message: err.message, details: err.details ?? null },
        });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        send(res, 500, { error: { code: "INTERNAL", message } });
      }
    }
  };
}

export interface StartedServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

/**
 * Start an HTTP server bound to loopback only. Port 0 lets the OS pick a free
 * port automatically; the chosen port is returned (and written to a local
 * project file by the caller's start script).
 */
export function startServer(dbPath: string, host = "127.0.0.1", port = 0): Promise<StartedServer> {
  const db = openDatabase(dbPath);
  const ctx = createApp(db);
  const server = createServer(requestHandler(ctx));
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      const address = server.address() as AddressInfo;
      resolve({
        server,
        port: address.port,
        async close() {
          await new Promise<void>((r) => server.close(() => r()));
          db.close();
        },
      });
    });
  });
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const dbPath = defaultDbPath();
  startServer(dbPath).then(({ port }) => {
    console.log(`[borehole] listening on http://127.0.0.1:${port}`);
    console.log(`[borehole] database: ${dbPath}`);
  });
}
