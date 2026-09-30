/**
 * Start the API server bound to 127.0.0.1 with an OS-assigned free port.
 * The chosen port is written to data/server.json (a project-local file) so
 * scripts/stop.mjs can stop exactly this process. Only manages this project.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(root, "data");
mkdirSync(dataDir, { recursive: true });
const pidFile = join(dataDir, "server.json");

if (existsSync(pidFile)) {
  const prev = JSON.parse(readFileSync(pidFile, "utf8"));
  if (prev.pid && isAlive(prev.pid)) {
    console.error(`server already running (pid ${prev.pid}, port ${prev.port})`);
    process.exit(1);
  }
}

const dbPath = process.env.BOREHOLE_DB ?? join(dataDir, "borehole.sqlite");
const entry = join(root, "dist", "api", "server.js");
if (!existsSync(entry)) {
  console.error("dist/ not found. Run 'npm run build' first.");
  process.exit(1);
}

const child = spawn(
  process.execPath,
  ["--experimental-sqlite", entry],
  {
    cwd: root,
    env: { ...process.env, BOREHOLE_DB: dbPath },
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  },
);

let started = false;
const onData = (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  const m = text.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
  if (m && !started) {
    started = true;
    writeFileSync(
      pidFile,
      JSON.stringify({ pid: child.pid, port: Number(m[1]), db: dbPath, startedAt: new Date().toISOString() }, null, 2),
    );
    console.log(`[start] recorded pid=${child.pid} port=${m[1]} -> ${pidFile}`);
  }
};
child.stdout.on("data", onData);
child.stderr.on("data", (c) => process.stderr.write(c));
child.on("exit", (code) => process.exit(code ?? 0));

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
