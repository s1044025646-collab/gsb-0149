import { test } from "node:test";
import assert from "node:assert/strict";
import { tempDb } from "./helpers.ts";
import { AppError } from "../src/core/errors.js";
import { METRES_PER_FOOT } from "../src/core/units.js";
import { openDatabase } from "../src/db/database.js";
import { Repository } from "../src/db/repository.js";

test("wells are stored and paginated", () => {
  const { db, repo } = tempDb();
  for (let i = 0; i < 3; i++) {
    repo.createWell({
      publicId: `w${i}`,
      name: `Well ${i}`,
      northRef: "grid",
      lengthUnit: "m",
      headNorth: 0,
      headEast: 0,
    });
  }
  const page = repo.listWells(2, 0);
  assert.equal(page.total, 3);
  assert.equal(page.rows.length, 2);
  const page2 = repo.listWells(2, 2);
  assert.equal(page2.rows.length, 1);
  db.close();
});

test("duplicate well id is a CONFLICT", () => {
  const { db, repo } = tempDb();
  repo.createWell({
    publicId: "dup",
    name: "A",
    northRef: "true",
    lengthUnit: "m",
    headNorth: 0,
    headEast: 0,
  });
  assert.throws(
    () =>
      repo.createWell({
        publicId: "dup",
        name: "B",
        northRef: "true",
        lengthUnit: "m",
        headNorth: 0,
        headEast: 0,
      }),
    (e: unknown) => e instanceof AppError && e.code === "CONFLICT",
  );
  db.close();
});

test("foot stations are converted to metres equivalently", () => {
  const { db, repo } = tempDb();
  const wellM = repo.createWell({
    publicId: "wm",
    name: "metric",
    northRef: "grid",
    lengthUnit: "m",
    headNorth: 0,
    headEast: 0,
  });
  repo.addVersion(
    wellM,
    [
      { md: 0, inc: 0, azi: 0 },
      { md: 30.48, inc: 0, azi: 0 },
    ],
    "t",
  );
  const wellF = repo.createWell({
    publicId: "wf",
    name: "imperial",
    northRef: "grid",
    lengthUnit: "ft",
    headNorth: 0,
    headEast: 0,
  });
  repo.addVersion(
    wellF,
    [
      { md: 0, inc: 0, azi: 0 },
      { md: 100, inc: 0, azi: 0 },
    ],
    "t",
  );
  const vM = repo.getLatestVersion(wellM.id)!;
  const vF = repo.getLatestVersion(wellF.id)!;
  assert.ok(Math.abs(repo.getAllStations(vM.id)[1]!.md - 100 * METRES_PER_FOOT) < 1e-9);
  assert.ok(Math.abs(repo.getAllStations(vF.id)[1]!.md - 100 * METRES_PER_FOOT) < 1e-9);
  db.close();
});

test("invalid input rolls the transaction back (no partial version/stations)", () => {
  const { db, repo } = tempDb();
  const well = repo.createWell({
    publicId: "roll",
    name: "rollback",
    northRef: "grid",
    lengthUnit: "m",
    headNorth: 0,
    headEast: 0,
  });
  assert.throws(
    () =>
      repo.addVersion(
        well,
        [
          { md: 0, inc: 0, azi: 0 },
          { md: 5, inc: 200, azi: 0 },
        ],
        "bad",
      ),
    (e: unknown) => e instanceof AppError,
  );
  assert.equal(repo.getLatestVersion(well.id), null);
  const count = db
    .prepare("SELECT COUNT(*) AS c FROM trajectory_versions WHERE well_id = ?")
    .get(well.id) as { c: number };
  assert.equal(count.c, 0);
  db.close();
});

test("revised stations create a NEW version; old version stays isolated", () => {
  const { db, repo, service } = tempDb();
  const well = repo.createWell({
    publicId: "rev",
    name: "revisions",
    northRef: "true",
    lengthUnit: "m",
    headNorth: 0,
    headEast: 0,
  });
  repo.addVersion(
    well,
    [
      { md: 0, inc: 0, azi: 0 },
      { md: 100, inc: 10, azi: 0 },
    ],
    "v1",
  );
  repo.addVersion(
    well,
    [
      { md: 0, inc: 0, azi: 0 },
      { md: 100, inc: 25, azi: 40 },
    ],
    "revised survey",
  );
  const v1 = service.reconstruct("rev", 1);
  const v2 = service.reconstruct("rev", 2);
  assert.equal(v1.version, 1);
  assert.equal(v2.version, 2);
  assert.ok(Math.abs(v1.result.points[1]!.n - v2.result.points[1]!.n) > 1);
  assert.equal(v1.result.points[1]!.inc, 10);
  db.close();
});

test("idempotent resubmission returns the same version without duplication", () => {
  const { db, repo } = tempDb();
  const well = repo.createWell({
    publicId: "idem",
    name: "idem",
    northRef: "grid",
    lengthUnit: "m",
    headNorth: 0,
    headEast: 0,
  });
  const stations = [
    { md: 0, inc: 0, azi: 0 },
    { md: 50, inc: 12, azi: 90 },
  ];
  const first = repo.addVersion(well, stations, "x", { idempotencyKey: "k-1" });
  const second = repo.addVersion(well, stations, "x", { idempotencyKey: "k-1" });
  assert.equal(first.version, second.version);
  assert.equal(second.reused, true);
  assert.equal(repo.listVersions(well.id, 10, 0).total, 1);
  db.close();
});

test("persistence survives closing and reopening the database file", () => {
  const { db, repo, path } = tempDb();
  repo.createWell({
    publicId: "persist",
    name: "persisted",
    northRef: "mag",
    lengthUnit: "m",
    headNorth: 12,
    headEast: 34,
  });
  db.close();

  const db2 = openDatabase(path);
  const repo2 = new Repository(db2);
  const again = repo2.getWellByPublicId("persist");
  assert.equal(again.north_ref, "mag");
  assert.equal(again.head_north, 12);
  db2.close();
});
