/**
 * The urgent path: a deployment that has been serving one shop is switched into
 * a platform, and that shop must come out the other side untouched.
 *
 * This is the production scenario end to end, including the two shortcuts that
 * make it a three-variable change rather than an afternoon of setup:
 *   - the control plane falls back to the deployment's own hosted database when
 *     it is not given one of its own;
 *   - `MM_DEFAULT_TENANT` registers the shop already living there, adopting it
 *     instead of seeding over it.
 * A regression here does not produce a failed request. It produces a shop whose
 * products are gone and whose owner cannot sign in, so the assertions below are
 * about the data being byte-for-byte what it was.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'data', 'adopt-self-test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

// A libsql `file:` URL is the same driver a Turso URL uses, so this exercises
// the hosted path without a network.
process.env.MM_DB_URL = `file:${path.join(dir, 'shop.db')}`;
process.env.MM_DB_DRIVER = 'libsql';
process.env.MM_JWT_SECRET = 'adopt-self-test-secret';
process.env.MM_PLATFORM = '1';
process.env.MM_DEFAULT_TENANT = 'mainshop';
process.env.MM_PLATFORM_OWNER_PASSWORD = 'owner-password-for-test';
delete process.env.MM_PLATFORM_DB_URL;

const config = (await import('../src/config/index.js')).default;
const { createApp, ensureDatabaseReady } = await import('../src/server.js');
const { initDb, getDb, closeDb } = await import('../src/infrastructure/database/connection.js');
const { applySchema } = await import('../src/infrastructure/database/connection.js');
const { seedBaseline } = await import('../src/infrastructure/database/seed.js');
const { runMigrations } = await import('../src/infrastructure/database/migrations/index.js');
const { closePlatformDb, platformDb } = await import('../src/platform/db.js');

let base = '';
let server = null;
let before_ = { users: 0, products: 0, adminHash: '' };

before(async () => {
  // A shop that is already trading, before anything knows about tenants.
  await initDb();
  await applySchema();
  await runMigrations();
  await seedBaseline();
  const db = getDb();
  await db.prepare(`
    INSERT INTO products (sku_prefix, name_en, name_ar, is_active, track_inventory)
    VALUES ('ADOPT-1', 'A product that existed first', 'منتج كان موجودًا', 1, 1)
  `).run();

  before_ = {
    users: (await db.prepare('SELECT COUNT(*) AS n FROM users').get()).n,
    products: (await db.prepare('SELECT COUNT(*) AS n FROM products').get()).n,
    adminHash: (await db.prepare("SELECT password_hash AS h FROM users WHERE username = 'admin'").get()).h,
  };

  // Now the platform comes up on top of it, exactly as a redeploy would.
  await ensureDatabaseReady();
  const app = createApp();
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await closeDb();
  await closePlatformDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the control plane shares the shop database when it is not given one of its own', () => {
  assert.equal(config.platform.driver, 'libsql');
  assert.equal(config.platform.url, process.env.MM_DB_URL);
  assert.equal(config.platform.shared, true, 'and says so, because it is worth moving off later');
});

test('the shop already there is registered without being touched', async () => {
  const row = await platformDb().prepare("SELECT * FROM tenants WHERE slug = 'mainshop'").get();
  assert.ok(row, 'the default tenant registered itself on boot');
  assert.equal(row.driver, 'libsql');
  assert.equal(row.db_url, process.env.MM_DB_URL);

  const db = getDb();
  const after_ = {
    users: (await db.prepare('SELECT COUNT(*) AS n FROM users').get()).n,
    products: (await db.prepare('SELECT COUNT(*) AS n FROM products').get()).n,
    adminHash: (await db.prepare("SELECT password_hash AS h FROM users WHERE username = 'admin'").get()).h,
  };
  assert.deepEqual(after_, before_, 'not one row seeded, not one password reset');
});

test('it keeps every module and no limits — the shop loses nothing by joining', async () => {
  const row = await platformDb().prepare("SELECT * FROM tenants WHERE slug = 'mainshop'").get();
  const modules = await platformDb()
    .prepare('SELECT module FROM tenant_modules WHERE tenant_id = ?').all(row.id);
  const { MODULES } = await import('../src/shared/permissions.js');
  assert.deepEqual(modules.map((m) => m.module).sort(), Object.keys(MODULES).sort());
  assert.equal(row.max_users, 0);
  assert.equal(row.max_products, 0);
  assert.equal(row.website_enabled, 1);
});

test('the addresses customers already had still reach the shop', async () => {
  const root = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/t/mainshop');

  const shop = await fetch(`${base}/shop`, { redirect: 'manual' });
  assert.equal(shop.headers.get('location'), '/t/mainshop/shop');
});

test('and the shop answers there, with its own data', async () => {
  const session = await (await fetch(`${base}/t/mainshop/api/session`)).json();
  assert.equal(session.tenant.slug, 'mainshop');

  const shopConfig = await (await fetch(`${base}/t/mainshop/api/shop/config`)).json();
  assert.equal(shopConfig.shopEnabled, true);

  const signIn = await fetch(`${base}/t/mainshop/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  assert.equal(signIn.status, 200, 'the existing admin signs in with the password they already had');
});

test('running the bootstrap again changes nothing', async () => {
  const { ensureDefaultTenant } = await import('../src/platform/bootstrapDefaultTenant.js');
  await ensureDefaultTenant();
  const rows = await platformDb().prepare("SELECT COUNT(*) AS n FROM tenants WHERE slug = 'mainshop'").get();
  assert.equal(rows.n, 1, 'one row, however many cold starts happen');
});

test('the owner console is at its own address and takes the password from the environment', async () => {
  const page = await fetch(`${base}/platform`);
  assert.equal(page.status, 200);

  const login = await fetch(`${base}/api/platform/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password: 'owner-password-for-test' }),
  });
  assert.equal(login.status, 200);
});
