import { test } from "node:test";
import assert from "node:assert/strict";
import {
  polylineFromPoints,
  segmentSegmentDistance,
  wellProximity,
} from "../src/core/proximity.js";
import type { Vec3 } from "../src/core/geometry.js";
import { AppError } from "../src/core/errors.js";

const P = (n: number, e: number, z: number): Vec3 => ({ n, e, z });

test("segment distance: intersecting segments are zero, skewed segments positive", () => {
  const cross = segmentSegmentDistance(
    { a: P(-10, 0, 0), b: P(10, 0, 0) },
    { a: P(0, -10, 0), b: P(0, 10, 0) },
  );
  assert.ok(Math.abs(cross.distance) < 1e-9);

  // Two parallel horizontal lines 5 m apart in east.
  const para = segmentSegmentDistance(
    { a: P(0, 0, 0), b: P(10, 0, 0) },
    { a: P(0, 5, 0), b: P(10, 5, 0) },
  );
  assert.ok(Math.abs(para.distance - 5) < 1e-9);

  // Closest approach between two finite segments can be interior-interior.
  const skew = segmentSegmentDistance(
    { a: P(0, 0, 0), b: P(10, 0, 0) },
    { a: P(3, 4, 1), b: P(7, 4, 1) },
  );
  assert.ok(Math.abs(skew.distance - Math.hypot(4, 1)) < 1e-9);
});

test("well proximity is symmetric in the two wells", () => {
  const a = polylineFromPoints([P(0, 0, 0), P(0, 0, 20), P(5, 0, 40)]);
  const b = polylineFromPoints([P(0, 8, 5), P(0, 8, 25), P(2, 8, 45)]);
  const ab = wellProximity(a, b, "grid", "grid");
  const ba = wellProximity(b, a, "grid", "grid");
  assert.ok(Math.abs(ab.minimumDistance - ba.minimumDistance) < 1e-12);
  assert.equal(ab.closest.segmentIndexA, ba.closest.segmentIndexB);
  assert.equal(ab.closest.segmentIndexB, ba.closest.segmentIndexA);
});

test("crossing wells have zero minimum distance", () => {
  // Two wells crossing at (n=5,e=5,z=10)
  const a = polylineFromPoints([P(0, 0, 10), P(10, 10, 10)]);
  const b = polylineFromPoints([P(0, 10, 10), P(10, 0, 10)]);
  const r = wellProximity(a, b, "true", "true");
  assert.ok(Math.abs(r.minimumDistance) < 1e-9);
  assert.ok(r.warning === false);
  const warned = wellProximity(a, b, "true", "true", { thresholdMetres: 1 });
  assert.equal(warned.warning, true);
});

test("near-parallel wells: distance is the constant separation, not station gap", () => {
  // Diagonal wells; offset must be PERPENDICULAR to the (north,tvd) tangent,
  // i.e. purely east, so the true separation stays 7 even though stations are
  // staggered by half a spacing along the well.
  const aPts: Vec3[] = [];
  const bPts: Vec3[] = [];
  for (let i = 0; i <= 10; i++) aPts.push(P(i * 10, 0, i * 10));
  for (let i = 0; i <= 10; i++) bPts.push(P(5 + i * 10, 7, 5 + i * 10));
  const r = wellProximity(polylineFromPoints(aPts), polylineFromPoints(bPts), "grid", "grid");
  assert.ok(Math.abs(r.minimumDistance - 7) < 1e-6);
});

test("translation invariance: shifting both wells leaves distance unchanged", () => {
  const a = polylineFromPoints([P(0, 0, 0), P(10, 0, 20)]);
  const b = polylineFromPoints([P(0, 5, 5), P(10, 5, 25)]);
  const shift = (pts: Vec3[], d: Vec3) => polylineFromPoints(pts.map((p) => P(p.n + d.n, p.e + d.e, p.z + d.z)));
  const d = P(123.4, -56.7, 89.0);
  const r1 = wellProximity(a, b, "grid", "grid");
  const r2 = wellProximity(shift(a.points, d), shift(b.points, d), "grid", "grid");
  assert.ok(Math.abs(r1.minimumDistance - r2.minimumDistance) < 1e-9);
});

test("rotation invariance around the vertical axis", () => {
  const a = polylineFromPoints([P(0, 0, 0), P(30, 10, 20)]);
  const b = polylineFromPoints([P(0, 6, 0), P(30, 16, 20)]);
  const theta = 0.731;
  const rot = (p: Vec3): Vec3 => ({
    n: p.n * Math.cos(theta) - p.e * Math.sin(theta),
    e: p.n * Math.sin(theta) + p.e * Math.cos(theta),
    z: p.z,
  });
  const r1 = wellProximity(a, b, "true", "true");
  const r2 = wellProximity(
    polylineFromPoints(a.points.map(rot)),
    polylineFromPoints(b.points.map(rot)),
    "true",
    "true",
  );
  assert.ok(Math.abs(r1.minimumDistance - r2.minimumDistance) < 1e-9);
});

test("different north references cannot be mixed", () => {
  const a = polylineFromPoints([P(0, 0, 0), P(10, 0, 10)]);
  const b = polylineFromPoints([P(0, 5, 0), P(10, 5, 10)]);
  assert.throws(
    () => wellProximity(a, b, "true", "mag"),
    (e: unknown) => e instanceof AppError && e.code === "NORTH_REF_MISMATCH",
  );
});

test("threshold breaches are enumerated and approximation bound reported", () => {
  const a = polylineFromPoints([P(0, 0, 0), P(100, 0, 0)]);
  const b = polylineFromPoints([P(0, 0.5, 0), P(100, 0.5, 0)]);
  const r = wellProximity(a, b, "grid", "grid", { thresholdMetres: 1 });
  assert.equal(r.breaches.length, 1);
  assert.ok(r.approximationBoundMetres > 0);
});
