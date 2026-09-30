import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "node:test";
import { openDatabase, closeDatabase, type Db } from "../src/db/database.js";
import { Repository, type Clock } from "../src/db/repository.js";
import { TrajectoryService } from "../src/core/service.js";

export function tempDb(): { db: Db; repo: Repository; service: TrajectoryService; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "borehole-"));
  const path = join(dir, "test.sqlite");
  const db = openDatabase(path);
  const repo = new Repository(db, fixedClock());
  const service = new TrajectoryService(repo);
  return { db, repo, service, path };
}

export function fixedClock(iso = "2026-01-01T00:00:00.000Z"): Clock {
  return { now: () => iso };
}

export function close(db: Db): void {
  closeDatabase(db);
}

export function cleanupDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export const APPROX = 1e-6;

/** Register an afterEach that disposes a db returned by tempDb. */
export function autoClose(ref: { db: Db; path: string }): void {
  afterEach(() => {
    try {
      closeDatabase(ref.db);
    } catch {
      // already closed
    }
    cleanupDir(ref.path.replace(/[\\/][^\\/]+$/, ""));
  });
}
