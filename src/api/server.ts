import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { writeFileSync } from 'node:fs';
import { Repository } from '../db/repo.ts';
import { Service, ValidationError, errorCode } from '../core/service.ts';
import { SurveyError } from '../core/geometry.ts';
import { ProximityError } from '../core/proximity.ts';

const HTTP_STATUS: Record<string, number> = {
  INVALID_FIELD: 400,
  INVALID_NORTH_REF: 400,
  INVALID_UNIT: 400,
  INVALID_STATIONS: 400,
  INVALID_MD: 400,
  INVALID_JSON: 400,
  INVALID_ANGLE: 422,
  INVALID_THRESHOLD: 400,
  MD_NOT_STRICTLY_INCREASING: 422,
  NEAR_REVERSE_TANGENT: 422,
  MD_OUT_OF_RANGE: 422,
  NO_STATIONS: 422,
  NO_SEGMENTS: 422,
  NO_TRAJECTORY: 409,
  NORTH_REF_MISMATCH: 409,
  INSUFFICIENT_STATIONS: 422,
  WELL_NOT_FOUND: 404,
  VERSION_NOT_FOUND: 404,
  WELL_EXISTS: 409,
  VERSION_EXISTS: 409,
  NOT_FOUND: 404,
  INTERNAL: 500,
};

export function createApp(repo: Repository): Server {
  const service = new Service(repo);

  const server = createServer(async (req, res) => {
    try {
      await route(service, req, res);
    } catch (err) {
      sendError(res, err);
    }
  });
  return server;
}

async function route(service: Service, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/health') {
    return json(res, 200, { status: 'ok' });
  }

  if (method === 'POST' && path === '/wells') {
    const body = await readJson(req);
    return json(res, 201, service.createWell(body));
  }

  if (method === 'GET' && path === '/wells') {
    const { limit, offset } = paging(url);
    const { data, total } = service.repo.listWells(limit, offset);
    return json(res, 200, paginate(data, total, limit, offset, '/wells'));
  }

  let m: RegExpMatchArray | null;

  if ((m = path.match(/^\/wells\/(\d+)$/))) {
    const id = Number(m[1]);
    if (method === 'GET') return json(res, 200, service.repo.getWell(id));
  }

  if ((m = path.match(/^\/wells\/(\d+)\/versions$/))) {
    const id = Number(m[1]);
    if (method === 'GET') {
      service.repo.getWell(id);
      return json(res, 200, { data: service.repo.listVersions(id) });
    }
    if (method === 'POST') {
      const body = await readJson(req);
      return json(res, 201, service.addVersion(id, body));
    }
  }

  if ((m = path.match(/^\/versions\/(\d+)\/segments$/))) {
    const id = Number(m[1]);
    if (method === 'GET') return json(res, 200, { data: service.segments(id) });
  }

  if ((m = path.match(/^\/versions\/(\d+)\/position$/))) {
    const id = Number(m[1]);
    if (method === 'GET') {
      const md = url.searchParams.get('md');
      if (md === null) throw new ValidationError('INVALID_MD', 'Query param md is required.');
      const unit = url.searchParams.get('unit') ?? undefined;
      return json(res, 200, service.positionAt(id, Number(md), unit as 'm' | 'ft' | undefined));
    }
  }

  if ((m = path.match(/^\/versions\/(\d+)\/max-dogleg$/))) {
    const id = Number(m[1]);
    if (method === 'GET') return json(res, 200, service.maxDogleg(id));
  }

  if (method === 'POST' && path === '/compare') {
    const body = await readJson(req);
    const a = id(body?.wellAId, 'wellAId');
    const b = id(body?.wellBId, 'wellBId');
    const threshold = body?.threshold;
    if (!(Number(threshold) > 0)) {
      throw new ValidationError('INVALID_THRESHOLD', 'threshold must be a positive number of metres.');
    }
    return json(res, 200, service.compare(a, b, Number(threshold), body?.idempotencyKey ?? undefined));
  }

  if (method === 'GET' && path === '/reports') {
    const { limit, offset } = paging(url);
    const { data, total } = service.repo.listReports(limit, offset);
    return json(res, 200, paginate(data.map(parseReport), total, limit, offset, '/reports'));
  }

  return json(res, 404, { error: { code: 'NOT_FOUND', message: `No route for ${method} ${path}` } });
}

function parseReport(r: any) {
  return { ...r, payload: JSON.parse(r.payload), within_threshold: !!r.within_threshold };
}

function id(v: any, field: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ValidationError('INVALID_FIELD', `Field '${field}' must be a positive integer id.`);
  }
  return n;
}

function paging(url: URL): { limit: number; offset: number } {
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') ?? 50)));
  const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0));
  return { limit, offset };
}

function paginate(data: unknown[], total: number, limit: number, offset: number, base: string) {
  return {
    data,
    paging: {
      total,
      limit,
      offset,
      next: offset + limit < total ? `${base}?limit=${limit}&offset=${offset + limit}` : null,
    },
  };
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError('INVALID_JSON', 'Request body must be valid JSON.');
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(s);
}

function sendError(res: ServerResponse, err: unknown): void {
  const code =
    err instanceof ValidationError
      ? err.code
      : err instanceof SurveyError
        ? err.code
        : err instanceof ProximityError
          ? err.code
          : errorCode(err);
  const status = HTTP_STATUS[code] ?? 500;
  json(res, status, { error: { code, message: (err as Error)?.message ?? 'Internal error' } });
}

/**
 * Start the server bound ONLY to the loopback interface. Port 0 lets the OS
 * assign an automatic free port; the chosen port is written to a project-local
 * file so the demo/CLI can discover it.
 */
export function startLocal(
  dbPath: string,
  opts: { portFile?: string; preferredPort?: number } = {},
): Promise<{ server: Server; port: number; close: () => void }> {
  const repo = Repository.open(dbPath);
  const server = createApp(repo);
  const host = '127.0.0.1';
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.preferredPort ?? 0, host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      if (opts.portFile) {
        writeFileSync(opts.portFile, String(port), 'utf8');
      }
      resolve({
        server,
        port,
        close: () => {
          server.close();
          repo.close();
        },
      });
    });
  });
}
