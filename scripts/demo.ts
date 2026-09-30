/**
 * Repeatable end-to-end demo against a throwaway database inside ./data.
 * Exercises wells in both units, a revised trajectory version, azimuth
 * crossing zero, and a crossing/parallel proximity comparison.
 */
import { rmSync } from "node:fs";
import { openDatabase } from "../src/db/database.js";
import { Repository } from "../src/db/repository.js";
import { TrajectoryService } from "../src/core/service.js";
import {
  buildArc,
  crossZeroWell,
  straightInclined,
  verticalWell,
} from "../src/core/generator.js";
import { dlsForUnit } from "../src/core/units.js";

const dbPath = "data/demo.sqlite";
rmSync(dbPath, { force: true });
rmSync(dbPath + "-wal", { force: true });
rmSync(dbPath + "-shm", { force: true });

const db = openDatabase(dbPath);
const repo = new Repository(db);
const service = new TrajectoryService(repo);

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

// 1. Vertical reference well.
const vertical = repo.createWell({
  publicId: "VERT-1",
  name: "Vertical pilot",
  northRef: "grid",
  lengthUnit: "m",
  headNorth: 0,
  headEast: 0,
});
repo.addVersion(vertical, verticalWell({ spacing: 10, totalLength: 200 }), "initial survey");

section("vertical well trajectory (first/last point)");
const vt = service.reconstruct("VERT-1");
console.log("first", vt.result.points[0]);
console.log("last ", vt.result.points.at(-1));

// 2. S-shaped build arc well in FEET to prove unit equivalence.
const arc = repo.createWell({
  publicId: "ARC-1",
  name: "Build-up arc (ft)",
  northRef: "grid",
  lengthUnit: "ft",
  headNorth: 20,
  headEast: 8,
});
repo.addVersion(arc, buildArc({ spacing: 30, totalLength: 600 }, 0, 45, 30, 90), "planned");
const arcRec = service.reconstruct("ARC-1");
section("arc well end point (metres, relative + world)");
console.log("relative", arcRec.result.points.at(-1));
console.log("world   ", arcRec.world.at(-1));

// 3. Revised survey -> new version, old preserved.
repo.addVersion(arc, buildArc({ spacing: 30, totalLength: 600 }, 0, 50, 30, 95), "revised gyro");
const dl = service.maxDogleg("ARC-1", 2);
section("revision creates version 2; max dogleg");
console.log("version count:", repo.listVersions(arc.id, 10, 0).total);
console.log(
  "v2 max dogleg deg:", dl.course.doglegDeg.toFixed(4),
  "DLS/100ft:", dlsForUnit(dl.course.dlsPer30m, "ft").toFixed(4),
);

// 4. Azimuth crossing zero.
const cross = repo.createWell({
  publicId: "CROSS-ZERO",
  name: "359->1 crossing north",
  northRef: "true",
  lengthUnit: "m",
  headNorth: 0,
  headEast: 0,
});
repo.addVersion(cross, crossZeroWell({ spacing: 5, totalLength: 40 }), "cross-zero");
section("azimuth crossing zero stays near north");
const cz = service.reconstruct("CROSS-ZERO");
for (const c of cz.result.courses.slice(0, 3)) {
  console.log(`dogleg ${c.doglegDeg.toFixed(4)} deg  dN ${c.deltaN.toFixed(3)}  dE ${c.deltaE.toFixed(3)}`);
}

// 5. Two crossing wells in world coordinates.
const xA = repo.createWell({
  publicId: "X-A",
  name: "crossing A",
  northRef: "grid",
  lengthUnit: "m",
  headNorth: 100,
  headEast: 0,
});
repo.addVersion(xA, straightInclined({ spacing: 10, totalLength: 120 }, 90, 135), "plan");
const xB = repo.createWell({
  publicId: "X-B",
  name: "crossing B",
  northRef: "grid",
  lengthUnit: "m",
  headNorth: 0,
  headEast: 0,
});
repo.addVersion(xB, straightInclined({ spacing: 10, totalLength: 120 }, 90, 45), "plan");
section("crossing wells minimum distance");
const crossing = service.compareWells("X-A", "X-B", { threshold: 2, reportId: "demo-crossing" });
console.log("minimum distance (m):", crossing.minimumDistance.toFixed(6), "warning:", crossing.warning);

// 6. Parallel wells 8 m apart with threshold.
const pA = repo.createWell({
  publicId: "P-A",
  name: "parallel A",
  northRef: "grid",
  lengthUnit: "m",
  headNorth: 300,
  headEast: 0,
});
repo.addVersion(pA, verticalWell({ spacing: 10, totalLength: 100 }), "plan");
const pB = repo.createWell({
  publicId: "P-B",
  name: "parallel B",
  northRef: "grid",
  lengthUnit: "m",
  headNorth: 300,
  headEast: 8,
});
repo.addVersion(pB, verticalWell({ spacing: 10, totalLength: 100 }), "plan");
const para = service.compareWells("P-A", "P-B", { threshold: 10, reportId: "demo-parallel" });
section("parallel wells threshold (10 m)");
console.log(
  "minimum distance:", para.minimumDistance.toFixed(3),
  "m warning:", para.warning,
  "polyline approx bound:", para.approximationBoundMetres.toFixed(3), "m",
);
console.log("NOTE: warning is geometric proximity only, not collision probability or proof of safety.");

// 7. Position interpolation.
section("interpolated position ARC-1 v2 at 250 ft");
console.log(service.queryAtMd("ARC-1", 250, 2));

db.close();
console.log(`\nDemo database written to ${dbPath} (delete it any time; all data stays in this project).`);
