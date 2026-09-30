import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSegments,
  rebuildTrajectory,
  tangent,
  angleBetween,
  ratioFactor,
  interpolateAtMd,
  interpolateAzi,
  SurveyError,
  DEG,
  UNIT_TO_M,
  type StationInput,
} from '../src/core/geometry.ts';

test('vertical well: zero horizontal displacement, TVD equals MD', () => {
  const st: StationInput[] = [
    { md: 0, inc: 0, azi: 0 },
    { md: 100, inc: 0, azi: 0 },
  ];
  const seg = computeSegments(st)[0];
  assert.ok(Math.abs(seg.dN) < 1e-9);
  assert.ok(Math.abs(seg.dE) < 1e-9);
  assert.ok(Math.abs(seg.dTVD - 100) < 1e-9);
  assert.equal(seg.doglegDeg, 0);
  assert.equal(seg.ratioFactor, 1); // stable straight-limit
});

test('constant-inclination straight line matches analytic displacement', () => {
  const inc = 30;
  const azi = 90; // due east
  const L = 100;
  const st: StationInput[] = [
    { md: 0, inc, azi },
    { md: L, inc, azi },
  ];
  const seg = computeSegments(st)[0];
  assert.ok(Math.abs(seg.dE - L * Math.sin(inc * DEG)) < 1e-9);
  assert.ok(Math.abs(seg.dTVD - L * Math.cos(inc * DEG)) < 1e-9);
  assert.ok(Math.abs(seg.dN) < 1e-9);
});

test('45deg constant slant: analytic N and TVD', () => {
  const L = 100 * Math.SQRT2; // choose so components are 100
  const st: StationInput[] = [
    { md: 0, inc: 45, azi: 0 },
    { md: L, inc: 45, azi: 0 },
  ];
  const seg = computeSegments(st)[0];
  assert.ok(Math.abs(seg.dN - 100) < 1e-9);
  assert.ok(Math.abs(seg.dTVD - 100) < 1e-9);
});

test('build arc: DLS is constant and integrated path is smooth', () => {
  // 0 -> 60 deg inclination over 600 m => 3 deg / 30 m, constant azimuth.
  const st: StationInput[] = [];
  const step = 30;
  for (let i = 0; i <= 20; i++) st.push({ md: i * step, inc: i * 3, azi: 0 });
  const segs = computeSegments(st);
  for (const s of segs) assert.ok(Math.abs(s.dlsDegPer30m - 3) < 1e-9);
  const pts = rebuildTrajectory(st);
  assert.ok(Math.abs(pts[0].tvd) < 1e-9);
  assert.ok(pts[pts.length - 1].tvd > 0);
});

test('azimuth crossing zero (359 -> 1) takes the short 2-degree arc', () => {
  const st: StationInput[] = [
    { md: 0, inc: 90, azi: 359 },
    { md: 30, inc: 90, azi: 1 },
  ];
  const seg = computeSegments(st)[0];
  assert.ok(Math.abs(seg.doglegDeg - 2) < 1e-9, 'dogleg should be 2 deg, not 358');
  assert.ok(interpolateAzi(359, 1, 0.5) > 359.9 || interpolateAzi(359, 1, 0.5) < 0.1);
});

test('short and long intervals coexist; DLS normalizes by length', () => {
  const st: StationInput[] = [
    { md: 0, inc: 0, azi: 0 },
    { md: 1, inc: 3, azi: 0 }, // 1 m interval: 90 deg/30m
    { md: 301, inc: 3, azi: 0 }, // long straight
  ];
  const segs = computeSegments(st);
  assert.ok(Math.abs(segs[0].dlsDegPer30m - 90) < 1e-6);
  assert.ok(Math.abs(segs[1].doglegDeg) < 1e-9);
});

test('MD must be strictly increasing', () => {
  assert.throws(
    () => computeSegments([
      { md: 10, inc: 0, azi: 0 },
      { md: 10, inc: 5, azi: 0 },
    ]),
    (e: Error) => e instanceof SurveyError && e.code === 'MD_NOT_STRICTLY_INCREASING',
  );
});

test('invalid inclination rejected', () => {
  assert.throws(
    () => computeSegments([
      { md: 0, inc: 0, azi: 0 },
      { md: 10, inc: 200, azi: 0 },
    ]),
    (e: Error) => e instanceof SurveyError && e.code === 'INVALID_ANGLE',
  );
});

test('near-reverse tangent rejected', () => {
  assert.throws(
    () =>
      computeSegments([
        { md: 0, inc: 1, azi: 0 },
        { md: 10, inc: 179, azi: 0 },
      ]),
    (e: Error) => e instanceof SurveyError && e.code === 'NEAR_REVERSE_TANGENT',
  );
});

test('non-finite angle rejected', () => {
  assert.throws(
    () => computeSegments([{ md: 0, inc: NaN, azi: 0 }, { md: 10, inc: 5, azi: 0 }]),
    (e: any) => e.code === 'INVALID_ANGLE',
  );
});

test('ratio factor continuous limit and grows with dogleg', () => {
  assert.equal(ratioFactor(0), 1);
  const small = ratioFactor(0.001);
  assert.ok(Math.abs(small - 1) < 1e-4);
  assert.ok(ratioFactor(0.5) > 1);
});

test('angleBetween never exceeds 180', () => {
  const a = tangent(90, 0);
  const b = tangent(90, 270);
  assert.ok(angleBetween(a, b) <= 180 + 1e-9);
});

test('MD interpolation: endpoints exact, midpoint average, out of range rejected', () => {
  const st: StationInput[] = [
    { md: 0, inc: 0, azi: 0 },
    { md: 100, inc: 0, azi: 0 },
  ];
  const pts = rebuildTrajectory(st);
  const p0 = interpolateAtMd(pts, 0);
  assert.equal(p0.tvd, 0);
  const pm = interpolateAtMd(pts, 50);
  assert.ok(Math.abs(pm.tvd - 50) < 1e-9);
  const p1 = interpolateAtMd(pts, 100);
  assert.ok(Math.abs(p1.tvd - 100) < 1e-9);
  assert.throws(() => interpolateAtMd(pts, 101), (e: any) => e.code === 'MD_OUT_OF_RANGE');
});

test('unit equivalence: feet trajectory equals metres after conversion', () => {
  const m: StationInput[] = [
    { md: 0, inc: 30, azi: 45 },
    { md: 30.48, inc: 30, azi: 45 },
  ];
  const ft: StationInput[] = [
    { md: 0, inc: 30, azi: 45 },
    { md: 100, inc: 30, azi: 45 },
  ];
  const segM = computeSegments(m)[0];
  const segFt = computeSegments(ft.map((s) => ({ ...s, md: s.md * UNIT_TO_M.ft })))[0];
  assert.ok(Math.abs(segM.dN - segFt.dN) < 1e-9);
  assert.ok(Math.abs(segM.dTVD - segFt.dTVD) < 1e-9);
});

