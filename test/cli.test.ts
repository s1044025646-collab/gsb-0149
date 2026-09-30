import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const cliTs = "src/cli/cli.ts";
const register = pathToFileURL(join(process.cwd(), "test", "register-ts.mjs")).href;

function runCli(args: string[], dbFile: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(
    process.execPath,
    ["--import", register, "--experimental-sqlite", cliTs, ...args],
    {
      env: { ...process.env, BOREHOLE_DB: dbFile },
      encoding: "utf8",
      cwd: process.cwd(),
    },
  );
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

describe("CLI", () => {
  let dir: string;
  let dbFile: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "borehole-cli-"));
    dbFile = join(dir, "cli.sqlite");
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("create well shows before/after state", () => {
    const r = runCli(
      ["create-well", "--id", "C1", "--name", "Cli Well", "--north-ref", "grid", "--unit", "m"],
      dbFile,
    );
    assert.equal(r.status, 0, r.stderr);
    if (r.status !== 0) console.error("DEBUG", r.stdout, r.stderr);
    assert.match(r.stdout, /\[before\] well 'C1' exists=false/);
    assert.match(r.stdout, /\[after\] created well id=C1/);
  });

  test("import JSON, trajectory, position, max-dogleg and export", () => {
    const stations = [
      { md: 0, inc: 0, azi: 0 },
      { md: 50, inc: 15, azi: 90 },
      { md: 100, inc: 30, azi: 90 },
    ];
    const file = join(dir, "stations.json");
    writeFileSync(file, JSON.stringify(stations), "utf8");

    const imp = runCli(["import", "--well", "C1", "--file", file, "--reason", "json"], dbFile);
    assert.equal(imp.status, 0, imp.stderr);
    assert.match(imp.stdout, /\[before\].*latestVersion=none/);
    assert.match(imp.stdout, /\[after\] version=1 reused=false/);

    const traj = runCli(["trajectory", "--well", "C1"], dbFile);
    assert.equal(traj.status, 0, traj.stderr);
    assert.match(traj.stdout, /md=100.000/);

    const pos = runCli(["position", "--well", "C1", "--md", "25"], dbFile);
    assert.equal(pos.status, 0, pos.stderr);
    assert.match(pos.stdout, /"requestedMd": 25/);

    const dl = runCli(["max-dogleg", "--well", "C1"], dbFile);
    assert.equal(dl.status, 0, dl.stderr);
    assert.match(dl.stdout, /maxDogleg=/);

    const outCsv = join(dir, "courses.csv");
    const exp = runCli(["export-increments", "--well", "C1", "--out", outCsv], dbFile);
    assert.equal(exp.status, 0, exp.stderr);
    assert.match(exp.stdout, /wrote 2 courses/);

    const csv = read(outCsv);
    assert.match(csv, /doglegDeg/);
  });

  test("repeated import with idempotency key is stable", () => {
    const file = join(dir, "stations.json");
    const a = runCli(
      ["import", "--well", "C1", "--file", file, "--reason", "again", "--idempotency-key", "K"],
      dbFile,
    );
    const b = runCli(
      ["import", "--well", "C1", "--file", file, "--reason", "again", "--idempotency-key", "K"],
      dbFile,
    );
    assert.match(a.stdout, /reused=false/);
    assert.match(b.stdout, /reused=true/);
  });

  test("invalid stations fail with an error code and no new version", () => {
    const bad = join(dir, "bad.json");
    writeFileSync(
      bad,
      JSON.stringify([
        { md: 0, inc: 0, azi: 0 },
        { md: 10, inc: 999, azi: 0 },
      ]),
      "utf8",
    );
    const r = runCli(["import", "--well", "C1", "--file", bad], dbFile);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /\[(VALIDATION|INVALID_ANGLE)\]/);
  });

  test("compare two wells with before/after listing", () => {
    runCli(
      ["create-well", "--id", "C2", "--name", "Second", "--north-ref", "grid", "--unit", "m",
        "--head-north", "0", "--head-east", "6"],
      dbFile,
    );
    const vertical = join(dir, "vert.json");
    writeFileSync(
      vertical,
      JSON.stringify([
        { md: 0, inc: 0, azi: 0 },
        { md: 100, inc: 0, azi: 0 },
      ]),
      "utf8",
    );
    runCli(["import", "--well", "C2", "--file", vertical], dbFile);
    const r = runCli(["compare", "--well-a", "C1", "--well-b", "C2", "--threshold", "10"], dbFile);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /minDistance=/);
    assert.match(r.stdout, /not proof of safety/);
  });

  test("north reference mismatch is refused with code", () => {
    runCli(
      ["create-well", "--id", "C3", "--name", "Mag", "--north-ref", "mag", "--unit", "m",
        "--head-east", "4"],
      dbFile,
    );
    const vertical = join(dir, "vert2.json");
    writeFileSync(
      vertical,
      JSON.stringify([
        { md: 0, inc: 0, azi: 0 },
        { md: 50, inc: 0, azi: 0 },
      ]),
      "utf8",
    );
    runCli(["import", "--well", "C3", "--file", vertical], dbFile);
    const r = runCli(["compare", "--well-a", "C1", "--well-b", "C3"], dbFile);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /\[NORTH_REF_MISMATCH\]/);
  });

  test("data persists across separate CLI invocations (restart)", () => {
    const r = runCli(["list-wells"], dbFile);
    assert.match(r.stdout, /wells total=3/);
    assert.match(r.stdout, /C1/);
    assert.match(r.stdout, /C2/);
  });
});

function read(p: string): string {
  return execFileSync(process.execPath, ["-e", `process.stdout.write(require('fs').readFileSync(${JSON.stringify(p)},'utf8'))`], {
    encoding: "utf8",
  });
}
