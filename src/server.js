/** HTTP entry point. Serves the API and the offline SPA from one process. */
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { exec } from 'node:child_process';
import config from './config/index.js';
import { applySchema, getDb, closeDb } from './infrastructure/database/connection.js';
import apiRouter from './api/routes/index.js';
import { attachRequestContext, errorHandler, notFoundHandler } from './api/middleware/index.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(attachRequestContext);

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      app: 'M&M Accessories ERP',
      version: '1.0.0',
      database: path.basename(config.paths.database),
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

export function start() {
  if (!fs.existsSync(config.paths.database)) {
    console.log('No database found — creating one from the schema…');
  }
  applySchema();

  const seeded = getDb().prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (seeded === 0) {
    console.warn('\n⚠  No users found. Run `npm run db:seed` before signing in.\n');
  }

  const app = createApp();
  const server = app.listen(config.server.port, config.server.host, () => {
    const url = `http://${config.server.host}:${config.server.port}`;
    console.log('');
    console.log('  M&M Accessories ERP');
    console.log('  ───────────────────────────────────────────');
    console.log(`  Running at   ${url}`);
    console.log(`  Database     ${config.paths.database}`);
    console.log(`  Backups      ${config.paths.backups}`);
    console.log('  Press Ctrl+C to stop');
    console.log('');
    if (config.server.openBrowser) openBrowser(url);
  });

  const shutdown = () => {
    console.log('\nShutting down…');
    server.close(() => {
      closeDb();
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
  start();
}
