#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Repository } from './db/repo.ts';
import { Service } from './core/service.ts';
import { generateSurvey } from './core/generator.ts';
import type { LengthUnit, StationInput } from './core/geometry.ts';

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  const dbPath = process.env.DRILL_DB ?? resolve('data/app.sqlite');
  const repo = Repository.open(dbPath);
  const svc = new Service(repo);
  try {
    switch (cmd) {
      case 'init':
        console.log(`[init] database ${dbPath} (migrations idempotent)`);
        console.log(`[init] schema ready; wells before=${repo.listWells(1, 0).total}`);
        return 0;

      case 'add-well': {
        const args = parseFlags(rest);
        const before = repo.listWells(1, 0).total;
        const w = svc.createWell({
          name: args.name,
          northRef: args.northRef,
          unit: args.unit,
          n0: Number(args.n0 ?? 0),
          e0: Number(args.e0 ?? 0),
          tvd0: Number(args.tvd0 ?? 0),
        });
        const after = repo.listWells(1, 0).total;
        console.log(`[add-well] wells ${before} -> ${after}`);
        console.log(JSON.stringify(w, null, 2));
        return 0;
      }

      case 'list-wells': {
        const { limit, offset } = flagsPaging(rest);
        const r = repo.listWells(limit, offset);
        console.log(JSON.stringify(r, null, 2));
        return 0;
      }

      case 'import': {
        const args = parseFlags(rest);
        const wellId = Number(args.well);
        const file = args.file;
        if (!file) throw new CliError('usage: import --well <id> --file <json> [--key k] [--note n]');
        const parsed = JSON.parse(readFileSync(resolve(file), 'utf8'));
        const stations: StationInput[] = parsed.stations ?? parsed;
        const before = repo.latestVersion(wellId)?.version ?? 0;
        const r = repo.addVersion(wellId, stations, {
          note: args.note ?? `import ${file}`,
          idempotencyKey: args.key ?? null,
        });
        const after = repo.latestVersion(wellId)?.version ?? 0;
        console.log(
          `[import] well ${wellId} version ${before} -> ${after}` +
            (r.reused ? ' (idempotent reuse)' : ` with ${stations.length} stations`),
        );
        console.log(JSON.stringify(r));
        return 0;
      }

      case 'gen': {
        const args = parseFlags(rest);
        const wellId = Number(args.well);
        const stations = generateSurvey({
          stations: args.stations ? Number(args.stations) : undefined,
          spacing: args.spacing ? Number(args.spacing) : undefined,
          startInc: args.inc ? Number(args.inc) : undefined,
          buildRate: args.build ? Number(args.build) : undefined,
          startAzi: args.azi ? Number(args.azi) : undefined,
          walkRate: args.walk ? Number(args.walk) : undefined,
          seed: args.seed ? Number(args.seed) : undefined,
          unit: (args.unit as LengthUnit) ?? 'm',
        });
        const before = repo.latestVersion(wellId)?.version ?? 0;
        const r = repo.addVersion(wellId, stations, {
          note: args.note ?? 'synthetic generated',
          idempotencyKey: args.key ?? null,
        });
        const after = repo.latestVersion(wellId)?.version ?? 0;
        console.log(`[gen] well ${wellId} version ${before} -> ${after}, ${stations.length} stations`);
        if (args.out) writeFileSync(resolve(args.out), JSON.stringify(stations, null, 2));
        console.log(JSON.stringify(r));
        return 0;
      }

      case 'trajectory': {
        const versionId = Number(rest[0]);
        const segs = svc.segments(versionId);
        console.log(JSON.stringify({ count: segs.length, segments: segs }, null, 2));
        return 0;
      }

      case 'position': {
        const args = parseFlags(rest);
        const versionId = Number(args.version);
        const p = svc.positionAt(versionId, Number(args.md), args.unit as LengthUnit | undefined);
        console.log(JSON.stringify(p, null, 2));
        return 0;
      }

      case 'max-dogleg': {
        const versionId = Number(rest[0]);
        console.log(JSON.stringify(svc.maxDogleg(versionId), null, 2));
        return 0;
      }

      case 'compare': {
        const args = parseFlags(rest);
        const r = svc.compare(
          Number(args.a),
          Number(args.b),
          Number(args.threshold ?? 10),
          args.key,
        );
        console.log(JSON.stringify(r, null, 2));
        return 0;
      }

      case 'export-increments': {
        const versionId = Number(rest[0]);
        const segs = svc.segments(versionId);
        const out = rest[1] ?? `tmp/segments-v${versionId}.json`;
        writeFileSync(resolve(out), JSON.stringify(segs, null, 2));
        console.log(`[export] wrote ${segs.length} segments to ${out}`);
        return 0;
      }

      default:
        console.log(usage());
        return cmd === undefined ? 0 : 2;
    }
  } catch (err) {
    console.error(`error [${(err as any).code ?? 'CLI'}]: ${(err as Error).message}`);
    return 1;
  } finally {
    repo.close();
  }
}

class CliError extends Error {}

function usage(): string {
  return [
    'usage: node src/cli.ts <command> [flags]',
    'commands:',
    '  init',
    '  add-well --name N --northRef TRUE_NORTH [--unit m|ft] [--n0 0 --e0 0 --tvd0 0]',
    '  list-wells [--limit N --offset M]',
    '  import --well <id> --file stations.json [--key k] [--note n]',
    '  gen --well <id> [--stations N --spacing M --inc I --build B --azi A --walk W --seed S --unit m|ft] [--out f] [--key k]',
    '  trajectory <versionId>',
    '  position --version <id> --md <depth> [--unit m|ft]',
    '  max-dogleg <versionId>',
    '  compare --a <wellId> --b <wellId> [--threshold metres] [--key k]',
    '  export-increments <versionId> [out.json]',
  ].join('\n');
}

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) out[a.slice(2)] = args[++i];
  }
  return out;
}

function flagsPaging(args: string[]) {
  const f = parseFlags(args);
  return {
    limit: Math.max(1, Math.min(200, Number(f.limit ?? 50))),
    offset: Math.max(0, Number(f.offset ?? 0)),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

export { main };
