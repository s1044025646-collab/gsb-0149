import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StartedServer } from "../src/api/server.ts";
import { startServer } from "../src/api/server.ts";

describe("HTTP API end to end", () => {
  let server: StartedServer;
  let base: string;
  let dir: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "borehole-api-"));
    server = await startServer(join(dir, "api.sqlite"), "127.0.0.1", 0);
    base = `http://127.0.0.1:${server.port}`;
  });
  after(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, any>;
    return { status: res.status, json };
  }

  test("health check", async () => {
    const r = await call("GET", "/health");
    assert.equal(r.status, 200);
    assert.equal(r.json.status, "ok");
  });

  test("validation error has explicit code and 400 status", async () => {
    const r = await call("POST", "/wells", { name: "x", northRef: "bogus", lengthUnit: "m", headNorth: 0, headEast: 0 });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, "VALIDATION");
  });

  test("malformed JSON rejected with BAD_REQUEST", async () => {
    const res = await fetch(base + "/wells", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const json = (await res.json()) as any;
    assert.equal(res.status, 400);
    assert.equal(json.error.code, "BAD_REQUEST");
  });

  test("full workflow: create, import version, reconstruct, position, compare", async () => {
    const w1 = await call("POST", "/wells", {
      id: "w1",
      name: "One",
      northRef: "grid",
      lengthUnit: "m",
      headNorth: 0,
      headEast: 0,
    });
    assert.equal(w1.status, 201);

    const imp = await call("POST", "/wells/w1/versions", {
      reason: "initial",
      stations: [
        { md: 0, inc: 0, azi: 0 },
        { md: 50, inc: 10, azi: 90 },
        { md: 100, inc: 20, azi: 90 },
      ],
    });
    assert.equal(imp.status, 201);
    assert.equal(imp.json.data.version, 1);

    const traj = await call("GET", "/wells/w1/trajectory");
    assert.equal(traj.status, 200);
    assert.equal(traj.json.data.points.length, 3);

    const pos = await call("GET", "/wells/w1/position?md=25");
    assert.equal(pos.status, 200);
    assert.ok(pos.json.data.world.tvd > 0);

    await call("POST", "/wells", {
      id: "w2",
      name: "Two",
      northRef: "grid",
      lengthUnit: "m",
      headNorth: 0,
      headEast: 10,
    });
    await call("POST", "/wells/w2/versions", {
      reason: "init",
      stations: [
        { md: 0, inc: 0, azi: 0 },
        { md: 100, inc: 0, azi: 0 },
      ],
    });
    const cmp = await call("POST", "/comparisons", {
      wellA: "w1",
      wellB: "w2",
      threshold: 15,
      id: "cmp-1",
    });
    assert.equal(cmp.status, 201);
    assert.equal(typeof cmp.json.data.minimumDistance, "number");
    assert.ok(cmp.json.caveats.noProbabilisticRisk.toLowerCase().includes("not a probability"));
  });

  test("idempotent import key returns same version", async () => {
    await call("POST", "/wells", {
      id: "idemw",
      name: "I",
      northRef: "true",
      lengthUnit: "m",
      headNorth: 0,
      headEast: 0,
    });
    const payload = {
      reason: "r",
      idempotencyKey: "abc",
      stations: [
        { md: 0, inc: 0, azi: 0 },
        { md: 10, inc: 5, azi: 10 },
      ],
    };
    const a = await call("POST", "/wells/idemw/versions", payload);
    const b = await call("POST", "/wells/idemw/versions", payload);
    assert.equal(a.json.data.version, b.json.data.version);
    assert.equal(b.json.data.reused, true);
  });

  test("pagination envelope works", async () => {
    const r = await call("GET", "/wells?limit=1&offset=0");
    assert.equal(r.status, 200);
    assert.equal(r.json.data.length, 1);
    assert.ok(r.json.pagination.total >= 3);
    assert.equal(r.json.pagination.hasMore, true);
  });

  test("404 for unknown well", async () => {
    const r = await call("GET", "/wells/does-not-exist");
    assert.equal(r.status, 404);
    assert.equal(r.json.error.code, "NOT_FOUND");
  });

  test("north reference conflict blocks comparison", async () => {
    await call("POST", "/wells", {
      id: "na",
      name: "NA",
      northRef: "true",
      lengthUnit: "m",
      headNorth: 0,
      headEast: 0,
    });
    await call("POST", "/wells/na/versions", {
      reason: "r",
      stations: [
        { md: 0, inc: 0, azi: 0 },
        { md: 10, inc: 1, azi: 1 },
      ],
    });
    await call("POST", "/wells", {
      id: "nb",
      name: "NB",
      northRef: "mag",
      lengthUnit: "m",
      headNorth: 0,
      headEast: 5,
    });
    await call("POST", "/wells/nb/versions", {
      reason: "r",
      stations: [
        { md: 0, inc: 0, azi: 0 },
        { md: 10, inc: 1, azi: 1 },
      ],
    });
    const r = await call("POST", "/comparisons", { wellA: "na", wellB: "nb" });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, "NORTH_REF_MISMATCH");
  });

  test("bad md rejected", async () => {
    const r = await call("GET", "/wells/w1/position?md=9999");
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, "OUT_OF_RANGE");
  });
});
