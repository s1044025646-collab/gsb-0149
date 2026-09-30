import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { startLocal } from './api/server.ts';

async function run() {
  const dbPath = process.env.DRILL_DB ?? resolve('data/app.sqlite');
  const portFile = process.env.DRILL_PORT_FILE ?? resolve('tmp/server.port');
  mkdirSync(resolve('data'), { recursive: true });
  mkdirSync(resolve('tmp'), { recursive: true });
  const { port } = await startLocal(dbPath, { portFile, preferredPort: Number(process.env.PORT) || 0 });
  console.log(`directional-drill backend listening on http://127.0.0.1:${port}`);
  console.log(`db: ${dbPath}`);
  console.log(`port file: ${portFile}`);

  const shutdown = () => {
    console.log('shutting down (project process only)...');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
