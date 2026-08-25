/**
 * A shop whose database is behind the code — and what happens on its next
 * request.
 *
 * ── The outage this file is the fence for ────────────────────────────────────
 * Migration 018 added `purchase_orders.discount_percent`, and the purchase-order
 * form began sending it. A single shop gets a new column on its next start,
 * because `start()` runs the migrations before it listens. A PLATFORM does not:
 * every shop is its own database, and the fleet is migrated by an operator
 * pressing a button in the console. Until somebody presses it, every shop in the
 * fleet is last week's schema under this week's code.
 *
 * The owner opened a brand-new shop, raised a purchase order, pressed save, and
 * got a bare `500`. Underneath it:
 *
 *     table purchase_orders has no column named discount_percent
 *
 * Nothing on his screen could have told him what was wrong, and nothing in the
 * system would have fixed it on its own.
 *
 * ── What is asserted here ────────────────────────────────────────────────────
 *  - a shop with a column missing gets it back on the next request, without
 *    anybody pressing anything;
 *  - the work happens ONCE per shop per process, because it is on the request
 *    path and a migration pass per request would be a round trip per request;
 *  - and a shop whose migrations cannot be applied still serves its request —
 *    the last time a migration threw on the request path, every route on three
 *    surfaces answered 500 (see `analyze()` in migrations/index.js). Degrading
 *    to "no worse than before" is the whole design of this net.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const testDataDir = path.join(here, '..', 'data', 'tenant-schema-drift-test');

process.env.MM_PLATFORM = '1';
process.env.MM_PLATFORM_DB = path.join(testDataDir, 'platform.db');
process.env.MM_TENANTS_DIR = path.join(testDataDir, 'tenants');
process.env.MM_DB_FILE = path.join(testDataDir, 'unused-default.db');

fs.rmSync(testDataDir, { recursive: true, force: true });
fs.mkdirSync(path.join(testDataDir, 'tenants'), { recursive: true });

const { createApp } = await import('../src/server.js');
const {
  initDb, closeDb, openConnection, runWithTenant,
} = await import('../src/infrastructure/database/connection.js');
const { initPlatformDb, closePlatformDb, platformDb } = await import('../src/platform/db.js');
const tenantService = (await import('../src/platform/TenantService.js')).default;
const { MODULES } = await import('../src/shared/permissions.js');
const { resetSchemaMemory, ensureMigrated } = await import('../src/platform/tenantSchema.js');
const { forgetTenant } = await import('../src/api/middleware/tenant.js');

let base = '';
let server = null;

before(async () => {
  await initDb();
  await initPlatformDb();
  const app = createApp();
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closeDb();
  await closePlatformDb();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

/** A shop, and a handle on its database for the surgery below. */
async function makeShop(slug) {
  await tenantService.create({
    slug,
    nameEn: `${slug} shop`,
    nameAr: `متجر ${slug}`,
    modules: Object.keys(MODULES),
    database: { mode: 'libsql', url: `file:${path.join(testDataDir, 'tenants', `${slug}.db`)}` },
  });
  const row = await platformDb().prepare('SELECT * FROM tenants WHERE slug = ?').get(slug);
  const connection = await openConnection({
    driver: row.driver, file: row.db_file, url: row.db_url, authToken: row.db_auth_token,
  });
  return { row, connection, run: (fn) => runWithTenant({ slug }, connection, () => fn(connection.facade)) };
}

/**
 * Wind a shop's database back to before a migration: drop the column and forget
 * that the migration ever ran. SQLite has supported `DROP COLUMN` since 3.35,
 * which is what makes it possible to reproduce the real thing rather than a
 * mock of it.
 */
async function windBack(shop, migration, table, column) {
  await shop.run(async (db) => {
    await db.prepare(`ALTER TABLE ${table} DROP COLUMN ${column}`).run();
    await db.prepare('DELETE FROM schema_migrations WHERE name = ?').run(migration);
  });
}

const hasColumn = (shop, table, column) => shop.run(async (db) => {
  const rows = await db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((row) => row.name === column);
});

test('a shop running behind the code catches up by itself', async (ctx) => {
  const shop = await makeShop('behind');
  await windBack(shop, '018-po-discount-percent', 'purchase_orders', 'discount_percent');
  await forgetTenant('behind');
  resetSchemaMemory();

  await ctx.test('the column really is gone — the fixture is the real thing', async () => {
    assert.equal(await hasColumn(shop, 'purchase_orders', 'discount_percent'), false);
  });

  await ctx.test('one request is enough to put it back', async () => {
    // Any request through the tenant router; this one needs no session.
    const res = await fetch(`${base}/t/behind/api/shop/config`);
    assert.ok(res.status < 500, `the request itself must not fail: ${res.status}`);
    assert.equal(await hasColumn(shop, 'purchase_orders', 'discount_percent'), true,
      'the shop is still behind the code, so its next purchase order will 500 '
      + 'with "no column named discount_percent" and nothing will say why');
  });

  await ctx.test('and it is not done again on every request', async () => {
    // The second call returns false — "nothing applied" — because the first
    // one recorded that this process has already checked this shop.
    assert.equal(await ensureMigrated('behind', shop.connection), false);
  });

  await shop.connection.close();
});

test('a shop whose migrations cannot run is still served', async (ctx) => {
  const shop = await makeShop('stuck');
  await forgetTenant('stuck');
  resetSchemaMemory();

  /**
   * A database that refuses the migration pass. `schema_migrations` is what
   * every run reads first, so a table of the wrong shape makes the whole pass
   * throw — the same way a statement the host will not accept did on the night
   * `ANALYZE` took the site down.
   */
  await shop.run(async (db) => {
    await db.prepare('DROP TABLE schema_migrations').run();
    await db.prepare('CREATE TABLE schema_migrations (wrong_shape INTEGER NOT NULL)').run();
  });

  await ctx.test('the request is answered rather than turned into an outage', async () => {
    const res = await fetch(`${base}/t/stuck/api/shop/config`);
    assert.ok(res.status < 500,
      `a shop that cannot be migrated must still trade: got ${res.status}`);
  });

  await shop.connection.close();
});
