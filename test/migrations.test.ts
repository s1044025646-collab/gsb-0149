import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase } from "../src/db/database.js";

test("migrations are repeatable on an existing database", () => {
  const dir = mkdtempSync(join(tmpdir(), "borehole-mig-"));
  const path = join(dir, "m.sqlite");
  const db1 = openDatabase(path);
  db1.exec("INSERT INTO wells(public_id,name,north_ref,length_unit,head_north,head_east,created_at,updated_at) VALUES('x','X','grid','m',0,0,'t','t')");
  db1.close();

  // Reopen and re-run migrations multiple times.
  for (let i = 0; i < 3; i++) {
    const db = openDatabase(path);
    migrate(db);
    const row = db.prepare("SELECT COUNT(*) AS c FROM wells").get() as { c: number };
    assert.equal(row.c, 1);
    db.close();
  }
  rmSync(dir, { recursive: true, force: true });
});

test("in-memory database migrates cleanly", () => {
  const db = openDatabase(":memory:");
  const v = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as {
    value: string;
  };
  assert.ok(Number(v.value) >= 1);
  db.close();
});
