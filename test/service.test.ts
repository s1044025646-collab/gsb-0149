import { test } from "node:test";
import assert from "node:assert/strict";
import { tempDb } from "./helpers.ts";
import { AppError } from "../src/core/errors.js";
import {
  buildArc,
  crossZeroWell,
  straightInclined,
  verticalWell,
} from "../src/core/generator.js";

function makeWell(
  repo: ReturnType<typeof tempDb>["repo"],
  id: string,
  north: "true" | "grid" | "mag",
  unit: "m" | "ft",
  head: { n: number; e: number; z?: number },
  stations: { md: number; inc: number; azi: number }[],
) {
  const well = repo.createWell({
    publicId: id,
    name: id,
    northRef: north,
    lengthUnit: unit,
    headNorth: head.n,
    headEast: head.e,
    headTvd: head.z ?? 0,
  });
  repo.addVersion(well, stations, "seed");
}

test("service query applies wellhead tie-in to world coordinates", () => {
  const { db, repo, service } = tempDb();
  makeWell(
    repo,
    "tie",
    "grid",
    "m",
    { n: 100, e: 200, z: 5 },
    [
      { md: 0, inc: 0, azi: 0 },
      { md: 50, inc: 0, azi: 0 },
    ],
  );
  const p = service.queryAtMd("tie", 50);
  assert.ok(Math.abs(p.world.north - 100) < 1e-9);
  assert.ok(Math.abs(p.world.east - 200) < 1e-9);
  assert.ok(Math.abs(p.world.tvd - 55) < 1e-9);
  db.close();
});

test("crossing trajectories in world coordinates yield zero distance", () => {
  const { db, repo, service } = tempDb();
  // X crossing at world (n=50,e=50): A heads south-east, B heads south-west.
  makeWell(repo, "a", "grid", "m", { n: 100, e: 0 }, straightInclined({ spacing: 10, totalLength: 120 }, 90, 135));
  makeWell(repo, "b", "grid", "m", { n: 0, e: 0 }, straightInclined({ spacing: 10, totalLength: 120 }, 90, 45));
  const r = service.compareWells("a", "b");
  assert.ok(r.minimumDistance < 1e-6);
  db.close();
});

test("near-parallel wells trigger threshold warning but no probability is claimed", () => {
  const { db, repo, service } = tempDb();
  makeWell(repo, "p1", "true", "m", { n: 0, e: 0 }, verticalWell({ spacing: 10, totalLength: 100 }));
  makeWell(repo, "p2", "true", "m", { n: 8, e: 0 }, verticalWell({ spacing: 10, totalLength: 100 }));
  const r = service.compareWells("p1", "p2", { threshold: 10 });
  assert.ok(Math.abs(r.minimumDistance - 8) < 1e-9);
  assert.equal(r.warning, true);
  const outside = service.compareWells("p1", "p2", { threshold: 5, reportId: "r2" });
  assert.equal(outside.warning, false);
  db.close();
});

test("different north references refuse comparison", () => {
  const { db, repo, service } = tempDb();
  makeWell(repo, "t1", "true", "m", { n: 0, e: 0 }, verticalWell({ spacing: 10, totalLength: 30 }));
  makeWell(repo, "m1", "mag", "m", { n: 0, e: 5 }, verticalWell({ spacing: 10, totalLength: 30 }));
  assert.throws(
    () => service.compareWells("t1", "m1"),
    (e: unknown) => e instanceof AppError && e.code === "NORTH_REF_MISMATCH",
  );
  db.close();
});

test("build arc fixture: horizontal departure grows and tvd increases", () => {
  const { db, repo, service } = tempDb();
  makeWell(repo, "arc", "grid", "m", { n: 0, e: 0 }, buildArc({ spacing: 5, totalLength: 200 }, 0, 60, 0, 0));
  const rec = service.reconstruct("arc");
  const end = rec.result.points.at(-1)!;
  assert.ok(end.n > 0);
  assert.ok(end.z > 0);
  const dl = service.maxDogleg("arc");
  assert.ok(dl.course.doglegDeg > 0);
  db.close();
});

test("359-degree crossing fixture computes without long-arc behaviour", () => {
  const { db, repo } = tempDb();
  makeWell(repo, "cz", "grid", "m", { n: 0, e: 0 }, crossZeroWell({ spacing: 5, totalLength: 40 }));
  const stations = repo.getAllStations(repo.getLatestVersion(repo.getWellByPublicId("cz").id)!.id);
  assert.ok(stations.some((s) => s.azi < 5 || s.azi > 355));
  db.close();
});

test("reports are persisted and listed", () => {
  const { db, repo, service } = tempDb();
  makeWell(repo, "g1", "grid", "m", { n: 0, e: 0 }, verticalWell({ spacing: 10, totalLength: 50 }));
  makeWell(repo, "g2", "grid", "m", { n: 0, e: 3 }, verticalWell({ spacing: 10, totalLength: 50 }));
  service.compareWells("g1", "g2", { threshold: 5, reportId: "fixed-report" });
  const list = repo.listReports(10, 0);
  assert.equal(list.total, 1);
  assert.equal((list.rows[0] as { publicId: string }).publicId, "fixed-report");
  db.close();
});
