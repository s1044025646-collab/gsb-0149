import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareWells, type WellPath } from '../src/core/proximity.ts';
import { rebuildTrajectory, type StationInput, DEG } from '../src/core/geometry.ts';

function path(
  wellId: number,
  name: string,
  stations: StationInput[],
  tie = { n0: 0, e0: 0, tvd0: 0 },
): WellPath {
  return { wellId, name, northRef: 'TRUE_NORTH', tieIn: tie, points: rebuildTrajectory(stations) };
}

test('crossing wells: segment distance reaches zero even without a station at crossing', () => {
  // Two horizontal perpendicular lines crossing at (0,0,100).
  const eastWest: StationInput[] = [
    { md: 0, inc: 90, azi: 90 },
    { md: 200, inc: 90, azi: 90 },
  ];
  // north-south line centered; tie-in offsets it so it crosses midpoint.
  const northSouth: StationInput[] = [
    { md: 0, inc: 90, azi: 0 },
    { md: 200, inc: 90, azi: 0 },
  ];
  // EW spans n=0, e in [-100,100]; NS spans n in [-100,100], e=0 -> interior cross at origin.
  const A = path(1, 'EW', eastWest, { n0: 0, e0: -100, tvd0: 100 });
  const B = path(2, 'NS', northSouth, { n0: -100, e0: 0, tvd0: 100 });
  const r = compareWells(A, B, 5);
  assert.ok(r.minDistance < 1e-9);
  assert.equal(r.withinThreshold, true);
  assert.ok(Math.abs(r.closest.mdA - 100) < 1e-6);
  assert.ok(Math.abs(r.closest.mdB - 100) < 1e-6);
});

test('distance is symmetric in well order', () => {
  const s1: StationInput[] = [
    { md: 0, inc: 90, azi: 0 },
    { md: 100, inc: 90, azi: 0 },
  ];
  const s2: StationInput[] = [
    { md: 0, inc: 90, azi: 90 },
    { md: 100, inc: 90, azi: 90 },
  ];
  const A = path(1, 'A', s1, { n0: 0, e0: 0, tvd0: 0 });
  const B = path(2, 'B', s2, { n0: 0, e0: 30, tvd0: 0 });
  const d1 = compareWells(A, B, 50).minDistance;
  const d2 = compareWells(B, A, 50).minDistance;
  assert.ok(Math.abs(d1 - d2) < 1e-9);
  assert.ok(Math.abs(d1 - 30) < 1e-9);
});

test('translation invariance', () => {
  const s1: StationInput[] = [
    { md: 0, inc: 90, azi: 0 },
    { md: 100, inc: 90, azi: 0 },
  ];
  const s2: StationInput[] = [
    { md: 0, inc: 90, azi: 0 },
    { md: 100, inc: 90, azi: 0 },
  ];
  const A = path(1, 'A', s1);
  const B = path(2, 'B', s2, { n0: 10, e0: 0, tvd0: 0 });
  const d = compareWells(A, B, 50).minDistance;
  const B2 = path(2, 'B', s2, { n0: 10 + 500, e0: -250, tvd0: 77 });
  const A2 = path(1, 'A', s1, { n0: 500, e0: -250, tvd0: 77 });
  const d2 = compareWells(A2, B2, 50).minDistance;
  assert.ok(Math.abs(d - d2) < 1e-9);
});

test('rotation invariance of two wells (rigid rotation about vertical)', () => {
  const s1: StationInput[] = [
    { md: 0, inc: 90, azi: 0 },
    { md: 100, inc: 90, azi: 0 },
  ];
  const s2: StationInput[] = [
    { md: 0, inc: 90, azi: 0 },
    { md: 100, inc: 90, azi: 0 },
  ];
  const A = path(1, 'A', s1);
  const B = path(2, 'B', s2, { n0: 20, e0: 5, tvd0: 0 });
  const d = compareWells(A, B, 50).minDistance;

  // Rotate both trajectories + tie-ins by 90 deg about the vertical axis.
  const rot = (p: WellPath): WellPath => ({
    ...p,
    tieIn: {
      n0: -p.tieIn.e0,
      e0: p.tieIn.n0,
      tvd0: p.tieIn.tvd0,
    },
    points: p.points.map((q) => ({ ...q, n: -q.e, e: q.n })),
  });
  const d2 = compareWells(rot(A), rot(B), 50).minDistance;
  assert.ok(Math.abs(d - d2) < 1e-9);
});

test('near-parallel wells: constant offset detected', () => {
  const mk = (azi: number): StationInput[] => [
    { md: 0, inc: 90, azi },
    { md: 50, inc: 90, azi },
    { md: 100, inc: 90, azi },
  ];
  const A = path(1, 'A', mk(0));
  const B = path(2, 'B', mk(0.01), { n0: 0, e0: 8, tvd0: 0 });
  const r = compareWells(A, B, 10);
  assert.ok(Math.abs(r.minDistance - 8) < 1e-6);
  assert.equal(r.withinThreshold, true);
});

test('threshold warning is not proof of safety: report carries limitations', () => {
  const s: StationInput[] = [
    { md: 0, inc: 0, azi: 0 },
    { md: 100, inc: 0, azi: 0 },
  ];
  const r = compareWells(path(1, 'A', s), path(2, 'B', s, { n0: 0, e0: 50, tvd0: 0 }), 10);
  assert.equal(r.withinThreshold, false);
  assert.ok(r.limitations.some((l) => /not proof of safe clearance/i.test(l)));
  assert.ok(r.limitations.some((l) => /no probabilistic collision/i.test(l)));
});

test('different north references cannot be mixed', () => {
  const s: StationInput[] = [
    { md: 0, inc: 0, azi: 0 },
    { md: 10, inc: 0, azi: 0 },
  ];
  const A = path(1, 'A', s);
  const B: WellPath = { ...path(2, 'B', s), northRef: 'MAGNETIC_NORTH' };
  assert.throws(() => compareWells(A, B, 5), (e: any) => e.code === 'NORTH_REF_MISMATCH');
});

test('invalid threshold rejected', () => {
  const s: StationInput[] = [
    { md: 0, inc: 0, azi: 0 },
    { md: 10, inc: 0, azi: 0 },
  ];
  assert.throws(() => compareWells(path(1, 'A', s), path(2, 'B', s), 0), (e: any) => e.code === 'INVALID_THRESHOLD');
});

// keep DEG import used for potential fixture math
void DEG;

