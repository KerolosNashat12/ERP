/**
 * The platform on a host with no disk.
 *
 * Everything here runs with a **libsql control plane** — `MM_PLATFORM_DB_URL`
 * is set before `src/config/index.js` is ever imported, exactly the way the
 * live Vercel deployment is configured. The URLs are local `file:` ones because
 * the libSQL client treats a `file:` database and a Turso database identically:
 * same statements, same transactions, same error shapes, no network. So this is
 * a real exercise of the hosted code path, not a mock of it.
 *
 * The first test is the one that matters most. Attaching a database that
 * already has a shop in it is how the owner's live M&M shop joins the platform,
 * pointing at the Turso database it is serving customers from right now. If
 * `create()` ever decides to seed that database, or to "helpfully" rewrite its
 * company name, a real shop loses real data. It is written first, and it asserts
 * on the things that would be destroyed rather than on the return value alone.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const testDataDir = path.join(here, '..', 'data', 'platform-hosted-test');

fs.rmSync(testDataDir, { recursive: true, force: true });
fs.mkdirSync(testDataDir, { recursive: true });

/** `file:` + an absolute path — the same URL shape the driver gets from Turso. */
const fileUrl = (name) => `file:${path.join(testDataDir, name)}`;

process.env.MM_PLATFORM = '1';
process.env.MM_PLATFORM_DB_URL = fileUrl('control-plane.db');
// The process default database is irrelevant in platform mode (every `/api`
// route 404s), but it must not be the real shop's file.
process.env.MM_DB_FILE = path.join(testDataDir, 'unused-default.db');
process.env.MM_TENANTS_DIR = path.join(testDataDir, 'tenants');

const { createApp } = await import('../src/server.js');
const { initDb, closeDb, openConnection, runWithTenant } = await import('../src/infrastructure/database/connection.js');
const { runMigrations } = await import('../src/infrastructure/database/migrations/index.js');
const { seedBaseline } = await import('../src/infrastructure/database/seed.js');
const { initPlatformDb, closePlatformDb, platformDb } = await import('../src/platform/db.js');
const tenantService = (await import('../src/platform/TenantService.js')).default;
const { MODULES } = await import('../src/shared/permissions.js');
const config = (await import('../src/config/index.js')).default;

let base = '';
let server = null;

before(async () => {
  // A guard, not a nicety. If MM_PLATFORM_DB_URL is ever not honoured, every
  // test below silently falls back to the developer's own `data/platform.db`
  // and writes fixture tenants into a real control plane. Refuse to run
  // instead.
  assert.equal(config.platform.driver, 'libsql',
    'the control plane must be the hosted driver — refusing to run against a local file');
  assert.equal(config.platform.url, process.env.MM_PLATFORM_DB_URL);

  await initDb();
  await initPlatformDb();
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
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

async function api(urlPath, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, cookie: setCookie ? setCookie.split(';')[0] : cookie };
}

const allModules = () => Object.keys(MODULES);

/** Open a libsql database directly — the "customer's own database", untouched by the platform. */
async function withDatabase(url, fn) {
  const connection = await openConnection({ driver: 'libsql', url });
  try {
    return await runWithTenant({ slug: 'fixture' }, connection, () => fn(connection.facade));
  } finally {
    await connection.close();
  }
}

/**
 * A database that already contains a running shop: schema, migrations, the
 * baseline, a password the owner chose, their own company name and their own
 * products. Nothing about it says "platform" — it is what a single-shop
 * deployment looks like the moment before it is adopted.
 */
async function buildExistingShop(url, { password, companyName, productNames }) {
  const connection = await openConnection({ driver: 'libsql', url });
  try {
    await runWithTenant({ slug: 'fixture' }, connection, async () => {
      await connection.applySchema();
      await runMigrations();
      await seedBaseline();
      const db = connection.facade;
      await db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE username = 'admin'")
        .run(bcrypt.hashSync(password, 4));
      await db.prepare("UPDATE settings SET value = ? WHERE key = 'company.name'").run(companyName);
      for (const [index, name] of productNames.entries()) {
        await db.prepare(`
          INSERT INTO products (sku_prefix, name_en, name_ar, base_cost, base_price, tax_rate)
          VALUES (?, ?, ?, 10, 25, 14)
        `).run(`EXIST-${index + 1}`, name, name);
      }
    });
  } finally {
    await connection.close();
  }
}

const readShop = (url) => withDatabase(url, async (db) => ({
  users: (await db.prepare('SELECT COUNT(*) AS n FROM users').get()).n,
  products: (await db.prepare('SELECT COUNT(*) AS n FROM products').get()).n,
  companyName: (await db.prepare("SELECT value AS v FROM settings WHERE key = 'company.name'").get())?.v,
  adminHash: (await db.prepare("SELECT password_hash AS h FROM users WHERE username = 'admin'").get())?.h,
  productNames: (await db.prepare('SELECT name_en FROM products ORDER BY id').all()).map((r) => r.name_en),
}));

const rowFor = async (slug) => platformDb().prepare('SELECT * FROM tenants WHERE slug = ?').get(slug);

// ---------------------------------------------------------------- 1. ADOPT
test('attaching a database that already has a shop in it adopts, never reseeds', async () => {
  const url = fileUrl('live-shop.db');
  const ownerPassword = 'the-owners-own-password-9';
  await buildExistingShop(url, {
    password: ownerPassword,
    companyName: 'M&M Accessories — the real one',
    productNames: ['Leather Wallet', 'Silk Scarf', 'Gold Cufflinks'],
  });
  const original = await readShop(url);
  assert.equal(original.users, 1);
  assert.equal(original.products, 3);

  const result = await tenantService.create({
    slug: 'live-shop',
    nameEn: 'Adopted Shop',
    nameAr: 'المتجر المُلحق',
    modules: allModules(),
    database: { mode: 'libsql', url },
  });

  // What the caller is told: this was an adoption, and here is what is in it.
  assert.equal(result.adopted, true, 'the result says plainly that nothing was created');
  assert.equal(result.users, original.users, 'the user count is read back from the database');
  assert.equal(result.products, original.products, 'the product count is read back from the database');
  assert.equal(result.adminPassword, undefined, 'no password was generated, so none is returned');

  // What actually matters: the shop's data is byte-for-byte what it was.
  const adopted = await readShop(url);
  assert.deepEqual(adopted.productNames, original.productNames, 'every product is still there, unchanged');
  assert.equal(adopted.users, original.users, 'no extra user was seeded');
  assert.equal(adopted.companyName, original.companyName, 'the shop\'s own company name was not overwritten');
  assert.equal(adopted.adminHash, original.adminHash, 'the admin password hash was not touched');

  // And the owner signs in with the password they already had.
  const login = await api('/t/live-shop/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: ownerPassword },
  });
  assert.equal(login.status, 200, 'the existing administrator still signs in with their existing password');

  const products = await api('/t/live-shop/api/products', { cookie: login.cookie });
  assert.equal(products.status, 200);
  assert.equal(products.data.rows.length, original.products, 'the tenant serves the products it already had');

  // The row records where the data lives — and no file was invented for it.
  const row = await rowFor('live-shop');
  assert.equal(row.driver, 'libsql');
  assert.equal(row.db_url, url);
  assert.equal(row.db_file, null, 'an attached database has no file on this machine');
});

// ------------------------------------------------------- 2. CREATE (hosted)
test('creating a tenant on an empty hosted database seeds it and returns a one-time password', async () => {
  const url = fileUrl('fresh-hosted.db');

  const result = await tenantService.create({
    slug: 'fresh-hosted',
    nameEn: 'Fresh Hosted Shop',
    nameAr: 'متجر مستضاف جديد',
    modules: allModules(),
    database: { mode: 'libsql', url },
  });

  assert.equal(result.adopted, undefined, 'an empty database is a creation, not an adoption');
  assert.equal(result.adminUsername, 'admin');
  assert.ok(result.adminPassword && result.adminPassword.length >= 16, 'a one-time password was generated');

  const login = await api('/t/fresh-hosted/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: result.adminPassword },
  });
  assert.equal(login.status, 200, 'the one-time password works against the hosted tenant');

  const products = await api('/t/fresh-hosted/api/products', { cookie: login.cookie });
  assert.equal(products.status, 200, '/t/<slug>/api/... serves the hosted tenant');
  assert.equal(products.data.rows.length, 0, 'a new shop starts empty — the baseline seeds no products');

  // The seed names the shop after the tenant, exactly as the file path does.
  const shop = await readShop(url);
  assert.equal(shop.companyName, 'Fresh Hosted Shop');
  assert.equal(shop.users, 1);
});

// ------------------------------------------------------------ 3. SAME URL
test('two tenants can never point at one database — the second attach is refused by name', async () => {
  const url = fileUrl('shared-by-mistake.db');
  await tenantService.create({
    slug: 'first-owner', nameEn: 'First Owner', modules: [], database: { mode: 'libsql', url },
  });

  await assert.rejects(
    () => tenantService.create({
      slug: 'second-owner', nameEn: 'Second Owner', modules: [], database: { mode: 'libsql', url },
    }),
    (error) => {
      assert.equal(error.status, 409, 'a conflict, not a validation error');
      assert.match(error.message, /first-owner/, 'the message names the tenant already using it');
      return true;
    },
  );

  assert.equal(await rowFor('second-owner'), null, 'and no half-made row is left behind');
});

// -------------------------------------------------------- 4. BAD URL/TOKEN
test('a URL that is not a database address is rejected before anything is opened', async () => {
  await assert.rejects(
    () => tenantService.create({
      slug: 'bad-scheme', nameEn: 'Bad Scheme', modules: [],
      database: { mode: 'libsql', url: 'postgres://user:pw@example.com/db' },
    }),
    (error) => {
      assert.match(error.message, /libsql:\/\/|https:\/\//, 'the message says what a valid URL looks like');
      assert.ok(!/stack|at Object|node_modules/i.test(error.message), 'no driver internals leak into it');
      return true;
    },
  );
  assert.equal(await rowFor('bad-scheme'), null, 'no control-plane row survives a rejected URL');
});

test('a database that cannot be reached fails readably and leaves no row behind', async () => {
  await assert.rejects(
    () => tenantService.create({
      slug: 'unreachable', nameEn: 'Unreachable', modules: [],
      // A well-formed URL the driver accepts and then cannot open — the same
      // class of failure as a wrong host or a rejected auth token.
      database: { mode: 'libsql', url: 'file:/no/such/directory/on/this/machine/shop.db' },
    }),
    (error) => {
      assert.match(error.message, /could not connect|cannot be reached|check the url/i,
        'a sentence a shop owner can act on');
      assert.ok(!/node_modules|\.js:\d+/.test(error.message), 'not a driver stack trace');
      return true;
    },
  );
  assert.equal(await rowFor('unreachable'), null, 'a failed attach leaves the control plane exactly as it was');
});

// ------------------------------------------------------------- 5. SECRETS
test('an auth token is never echoed back by the API', async () => {
  const token = 'super-secret-turso-token-do-not-echo';
  await tenantService.create({
    slug: 'token-holder',
    nameEn: 'Token Holder',
    modules: [],
    // A `file:` database ignores the token, which is exactly what makes it a
    // clean test of the fact that the token is stored and never returned.
    database: { mode: 'libsql', url: fileUrl('token-holder.db'), authToken: token },
  });

  const testPassword = 'hosted-platform-test-password-1';
  await platformDb().prepare(`
    INSERT INTO platform_users (username, password_hash, full_name, is_active, created_at)
    VALUES ('hosted-owner', ?, 'Hosted Owner', 1, ?)
  `).run(bcrypt.hashSync(testPassword, 4), new Date().toISOString());
  const login = await api('/api/platform/auth/login', {
    method: 'POST', body: { username: 'hosted-owner', password: testPassword },
  });
  assert.equal(login.status, 200);

  const detail = await api('/api/platform/tenants/token-holder', { cookie: login.cookie });
  assert.equal(detail.status, 200);
  assert.ok(!JSON.stringify(detail.data).includes(token), 'the token is not in the tenant payload');
  assert.equal(detail.data.database.hasAuthToken, true, 'only the fact that one is set is reported');

  const list = await api('/api/platform/tenants', { cookie: login.cookie });
  assert.ok(!JSON.stringify(list.data).includes(token), 'nor in the list payload');

  // What the create form asks before it picks a default, and all it is told.
  const environment = await api('/api/platform/environment', { cookie: login.cookie });
  assert.deepEqual(environment.data, { hostedControlPlane: true, canProvision: false },
    'the dashboard learns the shape of the deployment and nothing about its credentials');

  // It really was stored — the control plane needs it to open the database.
  assert.equal((await rowFor('token-holder')).db_auth_token, token);
});

// -------------------------------------------------- 6. THE CONTROL PLANE
test('the control plane itself is the hosted driver, and file tenants still work beside it', async () => {
  // Every test above wrote to it, so it is demonstrably a working database.
  const rows = await platformDb().prepare('SELECT slug FROM tenants ORDER BY slug').all();
  assert.ok(rows.length >= 4, 'the hosted control plane holds the tenants these tests created');

  // The default — a file tenant — is unchanged by any of this.
  const result = await tenantService.create({
    slug: 'still-a-file', nameEn: 'Still A File', modules: allModules(),
  });
  assert.ok(result.adminPassword, 'a file tenant is still seeded and still returns its password');
  const row = await rowFor('still-a-file');
  assert.equal(row.driver, 'sqlite');
  assert.ok(fs.existsSync(path.join(config.platform.tenantsDir, 'still-a-file.db')), 'its file was created');
});
