/** HTTP entry point. Serves the API and the SPA from one process. */
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { exec } from 'node:child_process';
import config from './config/index.js';
import {
  initDb, applySchema, getDb, closeDb, driverName,
} from './infrastructure/database/connection.js';
import { seedBaseline } from './infrastructure/database/seed.js';
import apiRouter from './api/routes/index.js';
import { attachRequestContext, errorHandler, notFoundHandler } from './api/middleware/index.js';

const isHostedDb = () => config.database.driver === 'libsql';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  /**
   * Serverless hosts import this module and invoke it per request — there is no
   * startup hook to open the database in. This opens the connection and, on a
   * hosted database, brings an empty one up once. Both are idempotent and
   * resolve immediately afterwards, so the per-request cost is a settled promise.
   */
  app.use((req, _res, next) => {
    ensureDatabaseReady().then(() => next(), next);
  });

  app.use(attachRequestContext);

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      app: 'M&M Accessories ERP',
      version: '1.0.0',
      driver: driverName(),
      database: isHostedDb() ? 'hosted' : path.basename(config.paths.database),
      time: new Date().toISOString(),
    });
  });

  app.use('/api', apiRouter);
  app.use('/api', notFoundHandler);

  // Static SPA — no build step, so it also works from a USB stick.
  app.use(express.static(config.paths.public, { index: false, maxAge: '1h' }));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(config.paths.public, 'index.html'));
  });

  app.use(errorHandler);
  return app;
}

/**
 * How many users exist. Returns null when the table is not there yet, which is
 * how a never-initialised database announces itself — the error text differs per
 * driver, so the absence is inferred from the failure rather than parsed out of it.
 */
async function countUsers() {
  try {
    const row = await getDb().prepare('SELECT COUNT(*) AS n FROM users').get();
    return row ? row.n : 0;
  } catch {
    return null;
  }
}

/**
 * Bring an empty hosted database up on its own.
 *
 * A serverless platform gives no startup hook and runs many instances, so this
 * has to happen on a request — but only ever once. `bootstrap` caches the
 * promise, so concurrent cold-start requests await the same work instead of
 * racing to seed, and every later request costs one already-resolved promise.
 *
 * Only the baseline is seeded. A public URL must not come up populated with
 * example products; that stays an explicit `npm run db:demo`.
 */
let bootstrap = null;

async function bootstrapHostedDatabase() {
  const existing = await countUsers();
  if (existing !== null && existing > 0) return;

  console.log('Hosted database is empty — applying the schema and seeding the administrator…');
  await applySchema();
  await seedBaseline();
  console.log('✔ Hosted database ready. Sign in as admin / admin123 and change that password.');
}

/** Idempotent, cheap after the first call. Awaited by the request middleware. */
export async function ensureDatabaseReady() {
  await initDb();
  if (!isHostedDb()) return;
  bootstrap = bootstrap || bootstrapHostedDatabase().catch((error) => {
    // Do not cache a failure: the next request should be able to try again.
    bootstrap = null;
    throw error;
  });
  await bootstrap;
}

/** Startup path for a local run, where a real `listen()` happens. */
async function prepareDatabase() {
  await initDb();

  if (isHostedDb()) {
    await ensureDatabaseReady();
    return;
  }

  if (!fs.existsSync(config.paths.database)) {
    console.log('No database found — creating one from the schema…');
  }
  await applySchema();

  if ((await countUsers()) === 0) {
    console.warn('\n⚠  No users found. Run `npm run db:seed` before signing in.\n');
  }
}

/**
 * The single app instance.
 *
 * Exported as the default because that is how serverless platforms pick an
 * Express app up: they import this module and route requests straight into the
 * app, never calling `listen()`. Locally, `start()` below does call `listen()`
 * on this same instance.
 */
const app = createApp();
export default app;

export async function start() {
  await prepareDatabase();

  const server = app.listen(config.server.port, config.server.host, () => {
    const url = `http://${config.server.host}:${config.server.port}`;
    console.log('');
    console.log('  M&M Accessories ERP');
    console.log('  ───────────────────────────────────────────');
    console.log(`  Running at   ${url}`);
    console.log(`  Database     ${isHostedDb() ? `hosted (${driverName()})` : config.paths.database}`);
    if (!isHostedDb()) console.log(`  Backups      ${config.paths.backups}`);
    console.log('  Press Ctrl+C to stop');
    console.log('');
    if (config.server.openBrowser) openBrowser(url);
  });

  const shutdown = () => {
    console.log('\nShutting down…');
    server.close(async () => {
      await closeDb();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

function openBrowser(url) {
  const command = process.platform === 'win32'
    ? `start "" "${url}"`
    : (process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`);
  exec(command, () => { /* opening a browser is best-effort */ });
}

if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  start().catch((error) => {
    console.error(`\n✖ ${error.message}\n`);
    process.exit(1);
  });
}
