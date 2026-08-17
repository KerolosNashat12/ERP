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
   * startup hook to open the database in. `initDb()` is idempotent and returns
   * immediately once connected, so paying for the check on every request is
   * cheaper than the alternative of a half-initialised process.
   */
  app.use((req, _res, next) => {
    initDb().then(() => next(), next);
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
 * Prepare the database and warn if it has no users yet.
 *
 * On a hosted database the schema is applied by `npm run db:migrate` from a
 * machine that has the credentials, not on every cold start — a serverless
 * instance should not be running DDL while a customer is waiting at the till.
 */
async function prepareDatabase() {
  await initDb();

  if (isHostedDb()) {
    const { n } = await getDb().prepare('SELECT COUNT(*) AS n FROM users').get()
      .catch(() => ({ n: 0 }));
    if (n === 0) {
      console.warn('\n⚠  Hosted database looks empty. Run `npm run setup` against it once.\n');
    }
    return;
  }

  if (!fs.existsSync(config.paths.database)) {
    console.log('No database found — creating one from the schema…');
  }
  await applySchema();

  const { n } = await getDb().prepare('SELECT COUNT(*) AS n FROM users').get();
  if (n === 0) {
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
