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
import { seedBaseline, hardenDefaultCredentials, syncPermissionCatalogue } from './infrastructure/database/seed.js';
import { runMigrations } from './infrastructure/database/migrations/index.js';
import apiRouter from './api/routes/index.js';
import shopRouter from './api/routes/shop.js';
import shopOrdersRouter from './api/routes/shopOrders.js';
import { publicLandingRouter } from './api/routes/landing.js';
import { attachRequestContext, errorHandler, notFoundHandler } from './api/middleware/index.js';
import { idempotency } from './api/middleware/idempotency.js';
import platformApiRouter from './api/routes/platform.js';
import { resolveTenant, resolveDefaultTenant } from './api/middleware/tenant.js';
import { currentTenant } from './infrastructure/database/connection.js';
import { initPlatformDb, platformDb } from './platform/db.js';
import { ensureDefaultTenant } from './platform/bootstrapDefaultTenant.js';

const isHostedDb = () => config.database.driver === 'libsql';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  /**
   * API answers are never cached, anywhere.
   *
   * This one was found the hard way. A phone browser had cached a 404 from
   * `/api/shop/brands` while the storefront was genuinely closed, and went on
   * showing "something is wrong" for as long as that entry lived — long after
   * the shop was open again, and no matter how many times the page was
   * reloaded. A CDN in front of the deployment can do exactly the same thing to
   * every visitor at once.
   *
   * Prices, stock, orders and sessions are all answers that were only ever true
   * at the moment they were given, so `no-store` is not a precaution here, it is
   * the correct description of them. Photo bytes are the one exception and set
   * their own long cache afterwards — they are immutable by construction, since
   * editing a photo means uploading a new one with a new id (see `sendImage`).
   */
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    next();
  });

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

  /**
   * One save, one document.
   *
   * Mounted in FRONT of every router that can write — the ERP's, the
   * storefront's and the console's — rather than on the routes that happen to
   * matter today. A purchase order is what the owner noticed, but a customer
   * double-tapping "confirm order" is the same bug with a worse consequence,
   * and the next route somebody adds is the same bug again. Sitting here, in
   * front of the routers, it covers all of them and asks nothing of whoever
   * writes the next one. See api/middleware/idempotency.js.
   *
   * Two of them, because a shop's claims and the console's belong in two
   * different databases: the ERP's follows the tenant that `resolveTenant` put
   * in scope (so it is that shop's own database, never another's), and the
   * console's is the control plane.
   */
  const guardShopWrites = idempotency({ scope: () => currentTenant()?.slug || 'shop' });
  const guardConsoleWrites = idempotency({ db: platformDb, scope: () => 'platform' });

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

  /**
   * The marketing page — the one address here that belongs to neither a shop
   * nor the owner's console.
   *
   * Registered before the platform block and before the single-shop mounts
   * below, because both of those end in a catch-all that would otherwise
   * answer `/kj` with a shop's index. It is deliberately outside every tenant
   * prefix: it sells the platform, so it is nobody's tenant and must read the
   * same whichever shop this deployment was started for.
   *
   * `/shared` is mounted with it. Vercel serves `public/` statically ahead of
   * this app, so in production `/shared/brandTheme.js` resolves without help —
   * but in platform mode there is no static mount at the root locally, and a
   * page that works live and 404s on the shop PC is a page nobody can check.
   */
  app.use('/kj', express.static(path.join(config.paths.public, 'kj'), {
    index: false, redirect: false, maxAge: '1h',
  }));
  app.use('/shared', express.static(path.join(config.paths.public, 'shared'), {
    index: false, redirect: false, maxAge: '1h',
  }));
  app.get(['/kj', '/kj/*'], (_req, res) => {
    res.sendFile(path.join(config.paths.public, 'kj', 'index.html'));
  });

  /**
   * What that page says, and the pictures on it — public, and mounted in BOTH
   * builds.
   *
   * It belongs here with `/kj` for the same reason `/kj` does: the marketing
   * page is nobody's tenant, so it must not sit behind `resolveTenant`, and it
   * must not fall into either `/api` catch-all below. In the single-shop build
   * there is no control plane to read, and that is not an error — nothing is
   * stored, so the page renders the defaults baked into `public/kj/defaults.js`,
   * which is exactly what a shop PC should show. See LandingContentService.
   */
  app.use('/api/landing', publicLandingRouter);

  /**
   * The platform is entirely additive: with `config.platform.enabled` false,
   * not one of these routes exists and everything below is the single-shop
   * build, untouched — `server.js` behaves byte-for-byte as it did before
   * multi-tenancy, which is rule 1 of the platform contract.
   *
   * `/api/platform` and `/t/:slug/api/*` are registered here, ahead of the
   * single-tenant `/api/shop` and `/api` mounts below, for the exact reason
   * those two are ordered relative to each other: Express matches `app.use`
   * by path prefix in registration order, so a more specific mount must come
   * first or the broader one swallows it — here that would mean an
   * unauthenticated `/api/platform/auth/login` hitting the ERP's own
   * `authenticate` middleware inside `apiRouter` and dying there as a plain
   * 401, never reaching the platform router at all.
   */
  if (config.platform.enabled) {
    app.use('/api/platform', guardConsoleWrites, platformApiRouter);
    // The owner's own dashboard: its own cookie, its own router, never a
    // tenant's data. Mounted before the ERP's own '/' catch-all below, so it
    // wins on that one path — everywhere else is unchanged.
    // With a default tenant named, the addresses this deployment already had
    // keep working: `/` and `/shop` are that shop's, and the console moves to
    // `/platform`. The redirect is deliberate rather than serving the same
    // files at two addresses — one canonical URL per page, so a customer who
    // shares the link shares the one that will still be right tomorrow.
    if (config.platform.defaultTenant) {
      const home = `/t/${config.platform.defaultTenant}`;
      app.get('/', (_req, res) => res.redirect(302, home));
      app.get('/shop*', (req, res) => res.redirect(302, `${home}/shop${req.path.slice('/shop'.length)}`));
    } else {
      app.get('/', (_req, res) => {
        res.sendFile(path.join(config.paths.public, 'platform', 'index.html'));
      });
    }
    app.use('/platform', express.static(path.join(config.paths.public, 'platform'), {
      index: false, redirect: false, maxAge: '1h',
    }));
    app.get('/platform*', (_req, res) => {
      res.sendFile(path.join(config.paths.public, 'platform', 'index.html'));
    });

    // Tenant traffic. The shop API is mounted before the general API for the
    // same reason as its single-tenant counterpart below: so nothing about a
    // public storefront request can inherit the ERP's own routing by accident.
    app.use('/t/:slug/api/shop', resolveTenant, guardShopWrites, shopRouter, shopOrdersRouter);
    app.use('/t/:slug/api', resolveTenant, guardShopWrites, apiRouter);
    app.use('/t/:slug/api', notFoundHandler);

    // A tenant with the website switched off must not leak that a shop is
    // there in any way — not the API (see shop.js/shopOrders.js), and not
    // the storefront's own HTML or static assets either. Registered ahead
    // of the static mount below, so a direct request for
    // `/t/<slug>/shop/index.html` cannot bypass the check that guards the
    // bare `/t/<slug>/shop` route by reaching the file through the static
    // server instead.
    app.use('/t/:slug/shop', resolveTenant, (req, res, next) => {
      if (!req.tenant.websiteEnabled) return res.status(404).end();
      return next();
    });

    // Static assets and the two SPAs, under the tenant's own prefix — so
    // `/t/mm/js/app.js` resolves before falling through to a page shell.
    app.use('/t/:slug', resolveTenant, express.static(config.paths.public, {
      index: false, redirect: false, maxAge: '1h',
    }));
    app.get('/t/:slug/shop*', resolveTenant, (_req, res) => {
      res.sendFile(path.join(config.paths.public, 'shop', 'index.html'));
    });
    app.get('/t/:slug*', resolveTenant, (_req, res) => {
      res.sendFile(path.join(config.paths.public, 'index.html'));
    });

    /**
     * The old addresses, still answering.
     *
     * With a default tenant named, an un-prefixed request is that shop's:
     * `/api/shop/products` is its storefront's, `/api/sales` is its till's. This
     * is not politeness, it is necessary — a host that serves `public/` as
     * static files answers `/shop` and `/` from its CDN before this application
     * sees them, so those pages load at the old addresses and call the old API
     * paths no matter what routes exist here. Closing those paths would have
     * broken a live storefront in front of its customers.
     *
     * Without a default tenant there is no "the shop", and the un-prefixed API
     * would otherwise serve the process default database, which on a platform
     * belongs to nobody — so there it stays closed.
     */
    if (config.platform.defaultTenant) {
      const asDefault = resolveDefaultTenant(config.platform.defaultTenant);
      app.use('/api/shop', asDefault, guardShopWrites, shopRouter, shopOrdersRouter);
      app.use('/api', asDefault, guardShopWrites, apiRouter);
    }

    /**
     * `/api/health` is mounted above all of this and stays up either way: a
     * deployment has to be able to say it is alive without naming a tenant.
     */
    app.use('/api/shop', notFoundHandler);
    app.use('/api', notFoundHandler);

    // Only page requests are answered with the owner's console. A request that
    // names a file — `/js/app.js`, `/css/app.css` — must fall through to the
    // static mount below, because both SPAs reference their assets from the
    // root: swallowing those here serves HTML where the browser asked for a
    // module and the page dies with a MIME type error and an empty screen.
    app.get('*', (req, res, next) => {
      if (path.extname(req.path)) return next();
      // An unknown page belongs to whoever owns the root: the default shop if
      // there is one, the console otherwise.
      if (config.platform.defaultTenant) {
        return res.sendFile(path.join(config.paths.public, 'index.html'));
      }
      return res.sendFile(path.join(config.paths.public, 'platform', 'index.html'));
    });
  }

  // Public storefront API. Mounted before the ERP router so nothing about the
  // shop can accidentally inherit its authentication middleware — and equally,
  // so the ERP's routes are never reachable without a session.
  app.use('/api/shop', guardShopWrites, shopRouter);
  app.use('/api/shop', guardShopWrites, shopOrdersRouter);

  app.use('/api', guardShopWrites, apiRouter);
  app.use('/api', notFoundHandler);

  // Static SPA — no build step, so it also works from a USB stick.
  // `redirect: false` matters: without it a request for /shop is answered with a
  // 301 to /shop/, so the address people share bounces before it loads. Assets
  // still resolve here first; only the bare directory falls through to the
  // storefront handler below.
  app.use(express.static(config.paths.public, { index: false, redirect: false, maxAge: '1h' }));
  app.get('/shop*', (_req, res) => {
    res.sendFile(path.join(config.paths.public, 'shop', 'index.html'));
  });
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

  // Applied on EVERY start, not only when the database is empty. That is what
  // makes a deploy which adds a table actually work: without it the new code
  // ships, builds cleanly, and then fails at runtime on a table the database
  // never got. Every statement is `CREATE … IF NOT EXISTS` and the views are
  // dropped and recreated, so re-applying is safe and costs one round trip.
  // This covers new tables, indexes and views — not a new column on an existing
  // table, which still needs a real migration.
  await applySchema();
  await applyMigrations();

  if (existing !== null && existing > 0) return;

  console.log('Hosted database is empty — seeding the administrator…');
  await seedBaseline();
  console.log('✔ Hosted database ready. Sign in as admin / admin123 — you will be asked to change it.');
}

/**
 * Structural changes that `CREATE … IF NOT EXISTS` cannot make — adding a column
 * to a table that already exists, mostly. Each runs once and is recorded.
 */
async function applyMigrations() {
  const ran = await runMigrations();
  if (ran.length) console.log(`✔ Applied ${ran.length} migration(s): ${ran.join(', ')}`);
}

/**
 * Runs on every start, not just the first: a database seeded before this check
 * existed can still be sitting on a published default password.
 */
async function syncPermissions() {
  try {
    const added = await syncPermissionCatalogue();
    if (added.length) console.log(`✔ New permissions registered: ${added.join(', ')}`);
  } catch (error) {
    console.warn(`Could not sync the permission catalogue: ${error.message}`);
  }
}

async function hardenCredentials() {
  try {
    const flagged = await hardenDefaultCredentials();
    if (flagged.length) {
      console.warn(`⚠  Default password still in use for: ${flagged.join(', ')} — a change is now forced at next sign-in.`);
    }
  } catch (error) {
    // Never let a hardening check stop the shop from opening.
    console.warn(`Could not check default credentials: ${error.message}`);
  }
}

/** Idempotent, cheap after the first call. Awaited by the request middleware. */
export async function ensureDatabaseReady() {
  await initDb();
  // The control plane is its own database, opened independently of the ERP's
  // default connection — see src/platform/db.js. Idempotent, so paying this
  // on every request (serverless has no other hook) costs one settled promise
  // after the first call.
  if (config.platform.enabled) await initPlatformDb();
  if (!isHostedDb()) return;
  bootstrap = bootstrap || bootstrapHostedDatabase().then(syncPermissions).then(hardenCredentials).catch((error) => {
    // Do not cache a failure: the next request should be able to try again.
    bootstrap = null;
    throw error;
  });
  await bootstrap;
  // Runs after the schema is up, so the shop it adopts is a shop that exists.
  // It never throws into a request — see ensureDefaultTenant.
  if (config.platform.enabled) await ensureDefaultTenant();
}

/** Startup path for a local run, where a real `listen()` happens. */
async function prepareDatabase() {
  await initDb();
  if (config.platform.enabled) await initPlatformDb();

  if (isHostedDb()) {
    await ensureDatabaseReady();
    return;
  }

  if (!fs.existsSync(config.paths.database)) {
    console.log('No database found — creating one from the schema…');
  }
  await applySchema();
  await applyMigrations();

  if ((await countUsers()) === 0) {
    console.warn('\n⚠  No users found. Run `npm run db:seed` before signing in.\n');
    return;
  }
  await syncPermissions();
  await hardenCredentials();
  if (config.platform.enabled) await ensureDefaultTenant();
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
