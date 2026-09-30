import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLocal } from '../src/api/server.ts';

const dir = mkdtempSync(join(tmpdir(), 'drill-api-'));
const dbPath = join(dir, 'api.sqlite');

const handle = await startLocal(dbPath);
const base = `http://127.0.0.1:${handle.port}`;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

test('health', async () => {
  const r = await call('GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'ok');
});

test('create well validation errors have codes', async () => {
  const bad = await call('POST', '/wells', { name: '', northRef: 'TRUE_NORTH' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'INVALID_FIELD');
  const badRef = await call('POST', '/wells', { name: 'X', northRef: 'GPS' });
  assert.equal(badRef.json.error.code, 'INVALID_NORTH_REF');
});

test('full e2e: wells, versions, trajectory, position, compare, pagination', async () => {
  const w1 = await call('POST', '/wells', { name: 'EW', northRef: 'TRUE_NORTH', n0: 0, e0: -100, tvd0: 100 });
  const w2 = await call('POST', '/wells', { name: 'NS', northRef: 'TRUE_NORTH', n0: -100, e0: 0, tvd0: 100 });
  assert.equal(w1.status, 201);
  const eastWest = [
    { md: 0, inc: 90, azi: 90 },
    { md: 200, inc: 90, azi: 90 },
  ];
  const northSouth = [
    { md: 0, inc: 90, azi: 0 },
    { md: 200, inc: 90, azi: 0 },
  ];
  const v1 = await call('POST', `/wells/${w1.json.id}/versions`, { stations: eastWest, idempotencyKey: 'a' });
  await call('POST', `/wells/${w2.json.id}/versions`, { stations: northSouth, idempotencyKey: 'b' });

  // idempotent re-submit
  const v1again = await call('POST', `/wells/${w1.json.id}/versions`, { stations: eastWest, idempotencyKey: 'a' });
  assert.equal(v1again.json.versionId, v1.json.versionId);

  const segs = await call('GET', `/versions/${v1.json.versionId}/segments`);
  assert.ok(Math.abs(segs.json.data[0].dE - 200) < 1e-9);

  const pos = await call('GET', `/versions/${v1.json.versionId}/position?md=100`);
  assert.ok(Math.abs(pos.json.e - 0) < 1e-9); // midpoint at e0+100 = 0

  const dlg = await call('GET', `/versions/${v1.json.versionId}/max-dogleg`);
  assert.equal(dlg.status, 200);

  const cmp = await call('POST', '/compare', {
    wellAId: w1.json.id,
    wellBId: w2.json.id,
    threshold: 5,
    idempotencyKey: 'cmp1',
  });
  assert.ok(cmp.json.report.minDistance < 1e-9);
  const cmpAgain = await call('POST', '/compare', {
    wellAId: w1.json.id,
    wellBId: w2.json.id,
    threshold: 5,
    idempotencyKey: 'cmp1',
  });
  assert.equal(cmpAgain.json.reportId, cmp.json.reportId);
});

test('north reference mismatch via API returns 409', async () => {
  const a = await call('POST', '/wells', { name: 'TN', northRef: 'TRUE_NORTH' });
  const b = await call('POST', '/wells', { name: 'MN', northRef: 'MAGNETIC_NORTH' });
  const st = [
    { md: 0, inc: 0, azi: 0 },
    { md: 100, inc: 0, azi: 0 },
  ];
  await call('POST', `/wells/${a.json.id}/versions`, { stations: st });
  await call('POST', `/wells/${b.json.id}/versions`, { stations: st });
  const r = await call('POST', '/compare', { wellAId: a.json.id, wellBId: b.json.id, threshold: 5 });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'NORTH_REF_MISMATCH');
});

test('invalid geometry rejected and rolls back', async () => {
  const w = await call('POST', '/wells', { name: 'BAD', northRef: 'TRUE_NORTH' });
  const r = await call('POST', `/wells/${w.json.id}/versions`, {
    stations: [
      { md: 0, inc: 0, azi: 0 },
      { md: 10, inc: 200, azi: 0 },
    ],
  });
  assert.equal(r.status, 422);
  assert.equal(r.json.error.code, 'INVALID_ANGLE');
  const versions = await call('GET', `/wells/${w.json.id}/versions`);
  assert.equal(versions.json.data.length, 0);
});

test('pagination response includes next link', async () => {
  const list = await call('GET', '/wells?limit=2&offset=0');
  assert.equal(list.json.paging.limit, 2);
  assert.ok(list.json.paging.next);
});

test('unknown route 404 with code', async () => {
  const r = await call('GET', '/nope');
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, 'NOT_FOUND');
});

test.after(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});
