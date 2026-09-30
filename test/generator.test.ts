import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildArc,
  crossZeroWell,
  mixedSpacing,
  seededRng,
  straightInclined,
  verticalWell,
} from "../src/core/generator.js";
import { computeTrajectory } from "../src/core/minimumCurvature.js";

test("seeded rng is reproducible", () => {
  const a = seededRng(42);
  const b = seededRng(42);
  for (let i = 0; i < 100; i++) assert.equal(a.next(), b.next());
  assert.notEqual(seededRng(1).next(), seededRng(2).next());
});

test("generator profiles produce valid strictly-increasing surveys", () => {
  const cases = [
    verticalWell({ spacing: 10, totalLength: 100 }),
    straightInclined({ spacing: 10, totalLength: 100 }, 45, 30),
    buildArc({ spacing: 10, totalLength: 200 }, 0, 60, 10, 350),
    crossZeroWell({ spacing: 5, totalLength: 50 }),
    mixedSpacing({ spacing: 0, totalLength: 0, longSpacing: 100, shortSpacing: 0.1 }, 20, 45),
  ];
  for (const stations of cases) {
    assert.ok(stations.length >= 2);
    const result = computeTrajectory(stations.map((s) => ({ md: s.md, inc: s.inc, azi: s.azi })));
    assert.ok(result.courses.length === stations.length - 1);
  }
});

test("cross-zero generated arc stays near north and never swings through south", () => {
  const stations = crossZeroWell({ spacing: 5, totalLength: 30 });
  const r = computeTrajectory(stations);
  for (const c of r.courses) {
    assert.ok(c.doglegDeg < 2);
    assert.ok(c.deltaN > 0);
  }
});

test("noise with a seed is deterministic", () => {
  const p = { spacing: 10, totalLength: 50, noiseDeg: 0.5, rng: seededRng(7) };
  const a = verticalWell(p);
  const b = verticalWell({ ...p, rng: seededRng(7) });
  assert.deepEqual(a, b);
});
