import { buildApp } from './app.ts';
import { ensureAdminUser } from './auth.ts';
import { loadConfig } from './config.ts';
import { openDatabase, pruneExpired } from './db.ts';

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

const config = loadConfig();
const db = openDatabase(config.dataDir);
const { app, ctx } = await buildApp(config, db);

await ensureAdminUser(db, config.adminUser, config.adminPassword, (message) =>
  app.log.info(message),
);

pruneExpired(db);
const pruneTimer = setInterval(() => pruneExpired(db), PRUNE_INTERVAL_MS);
pruneTimer.unref();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`${signal} received, shutting down`);
  clearInterval(pruneTimer);
  ctx.hub.stopAll();
  await app.close();
  db.close();
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal));
}

await app.listen({ host: config.host, port: config.port });
app.log.info(
  `hub listening on ${config.tls ? 'https' : 'http'}://${config.host}:${config.port}`,
);
