import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSurvey, mulberry32 } from '../src/core/generator.ts';
import { computeSegments } from '../src/core/geometry.ts';

test('generator is deterministic for a seed', () => {
  const a = generateSurvey({ seed: 42, stations: 10 });
  const b = generateSurvey({ seed: 42, stations: 10 });
  assert.deepEqual(a, b);
});

test('different seeds differ', () => {
  const a = generateSurvey({ seed: 1, stations: 10, noiseDeg: 1 });
  const b = generateSurvey({ seed: 2, stations: 10, noiseDeg: 1 });
  assert.notDeepEqual(a, b);
});

test('generated stations build a valid trajectory', () => {
  const st = generateSurvey({ stations: 31, spacing: 20, startInc: 0, buildRate: 3, seed: 5 });
  const segs = computeSegments(st);
  assert.equal(segs.length, 30);
  assert.ok(segs.every((s) => Number.isFinite(s.dN)));
});

test('mulberry32 within unit range', () => {
  const r = mulberry32(99);
  for (let i = 0; i < 1000; i++) {
    const x = r();
    assert.ok(x >= 0 && x < 1);
  }
});
