/**
 * Remove generated artifacts belonging ONLY to this project:
 *   dist/, data/*.sqlite* and the server pid file.
 * Source, tests and node_modules are left intact.
 */
import { rmSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

rmSync(join(root, "dist"), { recursive: true, force: true });

const dataDir = join(root, "data");
if (existsSync(dataDir)) {
  for (const name of readdirSync(dataDir)) {
    if (/\.(sqlite|sqlite-wal|sqlite-shm|db)$/.test(name) || /^(demo|borehole|api|cli|m|test)/.test(name)) {
      unlinkSync(join(dataDir, name));
    }
  }
}
rmSync(join(root, "data", "server.json"), { force: true });
console.log("cleaned dist/ and project-local databases in data/");
