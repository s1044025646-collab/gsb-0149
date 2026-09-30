/**
 * Stop the project-local API server recorded in data/server.json.
 * Only the PID in that file is targeted; nothing else is touched.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pidFile = join(root, "data", "server.json");

if (!existsSync(pidFile)) {
  console.log("no server pid file; nothing to stop");
  process.exit(0);
}

const info = JSON.parse(readFileSync(pidFile, "utf8"));
try {
  process.kill(info.pid);
  console.log(`stopped pid ${info.pid} (was on port ${info.port})`);
} catch (err) {
  if (err.code === "ESRCH") {
    console.log(`pid ${info.pid} was not running; cleaning stale file`);
  } else {
    throw err;
  }
} finally {
  rmSync(pidFile, { force: true });
}
