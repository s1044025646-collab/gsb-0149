import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeTrajectory,
  curvatureRatio,
  interpolateAtMd,
  maximumDogleg,
  type SurveyStation,
} from "../src/core/minimumCurvature.js";
import { azimuthDelta } from "../src/core/geometry.js";
import { AppError } from "../src/core/errors.js";

const S = (md: number, inc: number, azi: number): SurveyStation => ({ md, inc, azi });

test("vertical well: every increment is pure TVD, zero horizontal drift", () => {
  const r = computeTrajectory([S(0, 0, 0), S(10, 0, 0), S(20, 0, 0)]);
  for (const c of r.courses) {
    assert.ok(Math.abs(c.deltaN) < 1e-12);
    assert.ok(Math.abs(c.deltaE) < 1e-12);
    assert.ok(Math.abs(c.deltaTvd - c.length) < 1e-12);
    assert.ok(c.doglegDeg < 1e-9);
    assert.ok(c.dlsPer30m < 1e-9);
  }
  assert.ok(Math.abs(r.points.at(-1)!.z - 20) < 1e-12);
});

test("constant inclination straight tangent: analytic displacement check", () => {
  // inc 30, azi 90 (east), length 100.
  const r = computeTrajectory([S(0, 30, 90), S(100, 30, 90)]);
  const c = r.courses[0]!;
  assert.ok(Math.abs(c.deltaE - 100 * Math.sin(Math.PI / 6)) < 1e-9, "east = L sin(inc)");
  assert.ok(Math.abs(c.deltaN) < 1e-9);
  assert.ok(Math.abs(c.deltaTvd - 100 * Math.cos(Math.PI / 6)) < 1e-9, "tvd = L cos(inc)");
});

test("curvature ratio has stable limit 1 at zero and grows with beta", () => {
  assert.ok(Math.abs(curvatureRatio(0) - 1) < 1e-15);
  assert.ok(Math.abs(curvatureRatio(1e-12) - 1) < 1e-12);
  // f(beta) = tan(beta/2)/(beta/2) >= 1
  assert.ok(curvatureRatio(0.5) > 1);
  const beta = 0.5;
  const expected = Math.tan(beta / 2) / (beta / 2);
  assert.ok(Math.abs(curvatureRatio(beta) - expected) < 1e-12);
});

test("build arc: north/east/tvd increments integrate consistently", () => {
  // ramp inclination 0 -> 60 over 300 m, constant azimuth 0 (north)
  const stations: SurveyStation[] = [];
  for (let i = 0; i <= 30; i++) {
    stations.push(S(i * 10, (i / 30) * 60, 0));
  }
  const r = computeTrajectory(stations);
  const end = r.points.at(-1)!;
  // east must be zero by symmetry
  assert.ok(Math.abs(end.e) < 1e-9);
  // north and tvd positive; chord length cannot exceed measured depth
  const chord = Math.hypot(end.n, end.e, end.z);
  assert.ok(chord <= 300 + 1e-9);
  assert.ok(end.n > 0 && end.z > 0);
  // sum of course lengths equals total measured depth
  const sumL = r.courses.reduce((a, c) => a + c.length, 0);
  assert.ok(Math.abs(sumL - 300) < 1e-9);
});

test("azimuth crossing zero takes the short arc (359 -> 1 is 2 degrees)", () => {
  assert.ok(Math.abs(azimuthDelta(1, 359) - 2) < 1e-9);
  const r = computeTrajectory([S(0, 30, 359), S(10, 30, 1)]);
  const c = r.courses[0]!;
  // Expected dogleg: acos(cos^2 30 + sin^2 30 cos 2) ~= 0.99996 deg.
  assert.ok(Math.abs(c.doglegDeg - 2 * Math.sin(Math.PI / 6)) < 1e-3);
  // heading must remain near north, not swing south through 180
  assert.ok(c.deltaN > 0);
  assert.ok(Math.abs(c.deltaE) < 0.5);
});

test("long vs short courses both valid; short course keeps small increments", () => {
  const r = computeTrajectory([S(0, 10, 45), S(100, 10, 45), S(100.1, 10, 45), S(200, 10, 45)]);
  assert.equal(r.courses.length, 3);
  const short = r.courses[1]!;
  assert.ok(Math.abs(short.length - 0.1) < 1e-12);
  assert.ok(short.deltaTvd < 0.1);
});

test("measured depth must be strictly increasing", () => {
  assert.throws(
    () => computeTrajectory([S(0, 0, 0), S(0, 10, 0)]),
    (e: unknown) => e instanceof AppError && e.code === "MD_NOT_STRICTLY_INCREASING",
  );
  assert.throws(
    () => computeTrajectory([S(10, 0, 0), S(5, 0, 0)]),
    (e: unknown) => e instanceof AppError && e.code === "MD_NOT_STRICTLY_INCREASING",
  );
});

test("invalid angles rejected", () => {
  assert.throws(
    () => computeTrajectory([S(0, -1, 0)]),
    (e: unknown) => e instanceof AppError && e.code === "INVALID_ANGLE",
  );
  assert.throws(
    () => computeTrajectory([S(0, 90, 360)]),
    (e: unknown) => e instanceof AppError && e.code === "INVALID_ANGLE",
  );
  assert.throws(
    () => computeTrajectory([S(0, 90, -0.001)]),
    (e: unknown) => e instanceof AppError && e.code === "INVALID_ANGLE",
  );
});

test("near opposite tangents rejected", () => {
  // inc 0 points down; inc 180 points up -> 180 deg dogleg
  assert.throws(
    () => computeTrajectory([S(0, 0, 0), S(10, 180, 0)]),
    (e: unknown) => e instanceof AppError && e.code === "NEAR_OPPOSITE_TANGENT",
  );
});

test("interpolation at station boundaries is exact; interior lies on arc", () => {
  const r = computeTrajectory([S(0, 10, 20), S(50, 40, 80), S(100, 20, 200)]);
  const atStart = interpolateAtMd(r, 0);
  assert.equal(atStart.fraction, 0);
  assert.deepEqual(atStart.point, r.points[0]);
  const atMidStation = interpolateAtMd(r, 50);
  assert.equal(atMidStation.fraction, 0); // start of second course
  assert.ok(Math.abs(atMidStation.point.n - r.points[1]!.n) < 1e-12);
  const atEnd = interpolateAtMd(r, 100);
  assert.equal(atEnd.fraction, 1);
  assert.deepEqual(atEnd.point, r.points[2]);

  const mid = interpolateAtMd(r, 25);
  assert.ok(mid.fraction > 0 && mid.fraction < 1);
  // interior point must be within the axis-aligned bounds of the course
  assert.ok(mid.point.z >= Math.min(r.points[0]!.z, r.points[1]!.z) - 1e-9);
});

test("interpolation out of range rejected", () => {
  const r = computeTrajectory([S(0, 0, 0), S(10, 0, 0)]);
  assert.throws(
    () => interpolateAtMd(r, 11),
    (e: unknown) => e instanceof AppError && e.code === "OUT_OF_RANGE",
  );
});

test("maximum dogleg locates the steepest course", () => {
  const r = computeTrajectory([S(0, 0, 0), S(10, 5, 0), S(20, 45, 0), S(30, 50, 0)]);
  const best = maximumDogleg(r)!;
  assert.equal(best.fromIndex, 1);
  assert.ok(best.doglegDeg > 30);
});

test("DLS is degrees per 30 m: doubling course length halves severity", () => {
  const a = computeTrajectory([S(0, 0, 0), S(30, 30, 0)]).courses[0]!;
  const b = computeTrajectory([S(0, 0, 0), S(60, 30, 0)]).courses[0]!;
  assert.ok(Math.abs(a.dlsPer30m - 30) < 1e-9);
  assert.ok(Math.abs(b.dlsPer30m - 15) < 1e-9);
});
