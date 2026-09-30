import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository, type Clock } from '../src/db/repo.ts';
import { SurveyError } from '../src/core/geometry.ts';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'drill-'));
  dbPath = join(dir, 'test.sqlite');
});

function open(clock?: Clock) {
  return Repository.open(dbPath, clock);
}

const vertical = (n = 3) =>
  Array.from({ length: n }, (_, i) => ({ md: i * 30, inc: 0, azi: 0 }));

test('migrations are repeatable', () => {
  const repo = open();
  repo.migrate();
  repo.migrate();
  repo.close();
  const repo2 = open();
  repo2.migrate();
  repo2.close();
});

test('create well and duplicate name rejected with code', () => {
  const repo = open();
  repo.createWell({ name: 'W1', northRef: 'TRUE_NORTH' });
  assert.throws(() => repo.createWell({ name: 'W1', northRef: 'TRUE_NORTH' }), (e: any) => e.code === 'WELL_EXISTS');
  repo.close();
});

test('revising stations creates a new version; history is isolated', () => {
  const repo = open();
  const w = repo.createWell({ name: 'W', northRef: 'TRUE_NORTH' });
  const v1 = repo.addVersion(w.id, vertical(3), { note: 'first' });
  assert.equal(v1.version, 1);
  const v2 = repo.addVersion(w.id, vertical(4), { note: 'revised' });
  assert.equal(v2.version, 2);
  assert.notEqual(v1.versionId, v2.versionId);
  // version 1 unchanged
  assert.equal(repo.getStations(v1.versionId).length, 3);
  assert.equal(repo.getStations(v2.versionId).length, 4);
  assert.equal(repo.latestVersion(w.id)?.version, 2);
  repo.close();
});

test('idempotency key: repeated submit returns same version', () => {
  const repo = open();
  const w = repo.createWell({ name: 'W', northRef: 'TRUE_NORTH' });
  const a = repo.addVersion(w.id, vertical(3), { idempotencyKey: 'k1' });
  const b = repo.addVersion(w.id, vertical(5), { idempotencyKey: 'k1' });
  assert.equal(a.versionId, b.versionId);
  assert.equal(b.reused, true);
  assert.equal(repo.getStations(a.versionId).length, 3);
  repo.close();
});

test('invalid geometry rolls back the whole version transaction', () => {
  const repo = open();
  const w = repo.createWell({ name: 'W', northRef: 'TRUE_NORTH' });
  repo.addVersion(w.id, vertical(3), {});
  const versionsBefore = repo.listVersions(w.id).length;
  assert.throws(
    () =>
      repo.addVersion(w.id, [
        { md: 0, inc: 0, azi: 0 },
        { md: 0, inc: 5, azi: 0 }, // equal MD
      ], {}),
    (e) => e instanceof SurveyError && e.code === 'MD_NOT_STRICTLY_INCREASING',
  );
  const versionsAfter = repo.listVersions(w.id).length;
  assert.equal(versionsBefore, versionsAfter, 'no version row should remain after rollback');
  repo.close();
});

test('data persists across reopen (restart)', () => {
  const repo = open();
  const w = repo.createWell({ name: 'PERSIST', northRef: 'GRID_NORTH', n0: 5, e0: 6 });
  repo.addVersion(w.id, vertical(3), {});
  repo.close();
  assert.ok(existsSync(dbPath));
  const repo2 = open();
  const got = repo2.getWellByName('PERSIST')!;
  assert.equal(got.north_ref, 'GRID_NORTH');
  assert.equal(got.n0, 5);
  assert.equal(repo2.latestVersion(got.id)?.version, 1);
  assert.equal(repo2.getStations(repo2.latestVersion(got.id)!.id).length, 3);
  repo2.close();
});

test('injected clock controls created_at', () => {
  let t = 0;
  const clock: Clock = { now: () => new Date(Date.UTC(2026, 0, 1) + t) };
  const repo = open(clock);
  const w = repo.createWell({ name: 'T', northRef: 'TRUE_NORTH' });
  assert.equal(w.created_at, '2026-01-01T00:00:00.000Z');
  t = 60_000;
  const v = repo.addVersion(w.id, vertical(2), {});
  assert.equal(repo.getVersion(v.versionId).created_at, '2026-01-01T00:01:00.000Z');
  repo.close();
});

test('pagination metadata', () => {
  const repo = open();
  for (let i = 0; i < 5; i++) repo.createWell({ name: `P${i}`, northRef: 'TRUE_NORTH' });
  const page = repo.listWells(2, 2);
  assert.equal(page.total, 5);
  assert.equal(page.data.length, 2);
  assert.equal(page.data[0].id, 3);
  repo.close();
});

test('cleanup temp dir', () => {
  rmSync(dir, { recursive: true, force: true });
});
