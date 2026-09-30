/**
 * Repeatable, self-contained end-to-end demo. Uses a throwaway project-local
 * database under tmp/, builds two crossing synthetic wells, computes a version,
 * locates the max dog-leg, runs an inter-well comparison, exports per-segment
 * increments, and demonstrates a revised version (history isolation) plus the
 * north-reference guard. Safe to run repeatedly; it never touches real data.
 */
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Repository } from '../src/db/repo.ts';
import { Service } from '../src/core/service.ts';
import { generateSurvey } from '../src/core/generator.ts';

const dir = resolve('tmp/demo');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const dbPath = resolve(dir, 'demo.sqlite');

const repo = Repository.open(dbPath);
const svc = new Service(repo);

console.log('== repeatable directional-drilling demo ==');

const ew = svc.createWell({ name: 'EAST_WEST', northRef: 'TRUE_NORTH', n0: 0, e0: -100, tvd0: 100 });
const ns = svc.createWell({ name: 'NORTH_SOUTH', northRef: 'TRUE_NORTH', n0: -100, e0: 0, tvd0: 100 });
console.log('created wells:', ew.id, ns.id);

const ewStations = generateSurvey({ seed: 100, stations: 51, spacing: 4, startInc: 90, buildRate: 0, startAzi: 90 });
const nsStations = generateSurvey({ seed: 200, stations: 51, spacing: 4, startInc: 90, buildRate: 0, startAzi: 0 });

const v1 = repo.addVersion(ew.id, ewStations, { note: 'generated crossing well EW' });
const vn = repo.addVersion(ns.id, nsStations, { note: 'generated crossing well NS' });
console.log('versions:', v1.version, vn.version);

const buildWell = svc.createWell({ name: 'BUILD_ARC', northRef: 'TRUE_NORTH' });
const arc = generateSurvey({ seed: 300, stations: 31, spacing: 20, startInc: 0, buildRate: 3, startAzi: 60 });
const vb = repo.addVersion(buildWell.id, arc, { note: 'build arc 3 deg/30m' });
const maxDls = svc.maxDogleg(vb.versionId);
console.log('build-arc max dogleg segment:', {
  index: maxDls.index,
  dls: Number(maxDls.dlsDegPer30m.toFixed(4)),
});

const pos = svc.positionAt(v1.versionId, 100);
console.log('EW position at md=100m:', { n: pos.n.toFixed(3), e: pos.e.toFixed(3), tvd: pos.tvd.toFixed(3) });

const cmp = svc.compare(ew.id, ns.id, 10, 'demo-crossing');
console.log('inter-well min distance (m):', cmp.report.minDistance.toExponential(2),
  'within 10 m?', cmp.report.withinThreshold);
console.log('closest at mdA =', cmp.report.closest.mdA.toFixed(2), 'mdB =', cmp.report.closest.mdB.toFixed(2));

const increments = svc.segments(vb.versionId);
writeFileSync(resolve(dir, 'build-arc-increments.json'), JSON.stringify(increments, null, 2));
console.log('exported per-segment increments ->', resolve(dir, 'build-arc-increments.json'));

// Revised survey creates a new version while v1 stays isolated.
const revised = generateSurvey({ seed: 100, stations: 61, spacing: 4, startInc: 90, buildRate: 0.2, startAzi: 90 });
const v1b = repo.addVersion(ew.id, revised, { note: 'revised with slight build' });
console.log(`EW revised version ${v1.version} -> ${v1b.version}; v1 stations retained:`,
  repo.getStations(v1.versionId).length, 'v2 stations:', repo.getStations(v1b.versionId).length);

// North reference guard.
const mag = svc.createWell({ name: 'MAGNETIC', northRef: 'MAGNETIC_NORTH' });
repo.addVersion(mag.id, generateSurvey({ seed: 9, stations: 5 }), {});
try {
  svc.compare(ew.id, mag.id, 50);
} catch (e: any) {
  console.log('north-ref guard ->', e.code, ':', e.message);
}

console.log('distance reports stored:', repo.listReports().total);
console.log('demo db (reopen to inspect):', dbPath);
repo.close();

// Prove persistence across restart.
const reopened = Repository.open(dbPath);
console.log('after reopen, wells =', reopened.listWells().total,
  'EW latest version =', reopened.latestVersion(ew.id)?.version);
reopened.close();
