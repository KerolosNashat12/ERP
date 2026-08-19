/**
 * The multi-tenant platform, exercised through the real HTTP surface.
 *
 * Every environment variable that `src/config/index.js` reads must be set
 * before that module (or anything importing it) is ever loaded — module
 * evaluation happens once, on first import, and freezes the config object.
 * So this file sets MM_PLATFORM and friends, THEN dynamically imports the
 * server and everything downstream of it.
 *
 * Node's test runner gives every matched test file its own process by
 * default, so setting these here does not leak into the other suites, and
 * their un-set MM_PLATFORM leaves them running the single-shop build exactly
 * as before — which is the whole point of the switch.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import bcrypt from 'bcryptjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const testDataDir = path.join(here, '..', 'data', 'platform-test');

process.env.MM_PLATFORM = '1';
process.env.MM_PLATFORM_DB = path.join(testDataDir, 'platform.db');
process.env.MM_TENANTS_DIR = path.join(testDataDir, 'tenants');

fs.rmSync(testDataDir, { recursive: true, force: true });
fs.mkdirSync(testDataDir, { recursive: true });

const { createApp } = await import('../src/server.js');
const { initDb, closeDb, openConnection, runWithTenant } = await import('../src/infrastructure/database/connection.js');
const { runMigrations } = await import('../src/infrastructure/database/migrations/index.js');
const { seedBaseline } = await import('../src/infrastructure/database/seed.js');
const { initPlatformDb, closePlatformDb, platformDb } = await import('../src/platform/db.js');
const tenantService = (await import('../src/platform/TenantService.js')).default;
const { migrateAllTenants } = await import('../src/platform/migrateAll.js');
const { MODULES } = await import('../src/shared/permissions.js');
const { forgetTenant } = await import('../src/api/middleware/tenant.js');
const config = (await import('../src/config/index.js')).default;

let base = process.env.MM_TEST_URL || '';
let server = null;

before(async () => {
  if (base) return;
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

/** Every call carries its own cookie — several tenants are live at once here. */
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

const cookieValue = (cookiePair) => cookiePair.slice(cookiePair.indexOf('=') + 1);

async function provisionTenant(slug, nameEn) {
  // Every module enabled: this file is about tenant isolation, not
  // entitlements (that is tests/entitlements.test.js's job) — an empty
  // module list would now correctly 403 the very `/api/products` calls
  // these tests use to prove isolation, which is not what they are
  // checking, so it is neutralised here the same way `tenant-import.js`
  // does for a real migration.
  const provisioned = await tenantService.create({
    slug, nameEn, nameAr: nameEn, modules: Object.keys(MODULES), limits: {}, websiteEnabled: true,
  });
  const login = await api(`/t/${slug}/api/auth/login`, {
    method: 'POST',
    body: { username: provisioned.adminUsername, password: provisioned.adminPassword },
  });
  assert.equal(login.status, 200, `tenant ${slug} admin can sign in with the one-time password`);
  return { ...provisioned, cookie: login.cookie };
}

async function createProduct(slug, cookie, nameEn) {
  const res = await api(`/t/${slug}/api/products`, {
    method: 'POST',
    cookie,
    body: {
      sku_prefix: `${slug.toUpperCase()}-${Date.now().toString().slice(-6)}`,
      name_en: nameEn,
      base_cost: 10,
      base_price: 20,
      tax_rate: 14,
      attribute_ids: [],
      variants: [],
    },
  });
  assert.equal(res.status, 201, `product created for ${slug}`);
  return res.data;
}

// ------------------------------------------------------------------ 1, 2, 3
test('two tenants, each with their own product, never see each other\'s data — even interleaved', async () => {
  const tenantA = await provisionTenant('acme-a', 'Acme A');
  const tenantB = await provisionTenant('acme-b', 'Acme B');

  const nameA = 'Tenant A Exclusive Widget';
  const nameB = 'Tenant B Exclusive Gadget';
  await createProduct('acme-a', tenantA.cookie, nameA);
  await createProduct('acme-b', tenantB.cookie, nameB);

  // Fired together, not one after the other: several rounds of A and B
  // requests interleaved, so any bug that leaks the AsyncLocalStorage
  // context between concurrent requests has many chances to show up.
  const calls = [];
  for (let i = 0; i < 6; i += 1) {
    calls.push(api('/t/acme-a/api/products', { cookie: tenantA.cookie }).then((r) => ({ who: 'A', r })));
    calls.push(api('/t/acme-b/api/products', { cookie: tenantB.cookie }).then((r) => ({ who: 'B', r })));
  }
  const settled = await Promise.all(calls);

  assert.equal(settled.length, 12);
  for (const { who, r } of settled) {
    assert.equal(r.status, 200);
    const names = r.data.rows.map((p) => p.name_en);
    if (who === 'A') {
      assert.ok(names.includes(nameA), 'tenant A sees its own product');
      assert.ok(!names.includes(nameB), 'tenant A never sees tenant B\'s product');
    } else {
      assert.ok(names.includes(nameB), 'tenant B sees its own product');
      assert.ok(!names.includes(nameA), 'tenant B never sees tenant A\'s product');
    }
  }
});

test('a suspended tenant answers 423', async () => {
  await tenantService.create({
    slug: 'suspended-shop', nameEn: 'Suspended Shop', nameAr: 'Suspended Shop', modules: [], websiteEnabled: true,
  });
  await tenantService.suspend('suspended-shop');

  const res = await api('/t/suspended-shop');
  assert.equal(res.status, 423);
  assert.equal(res.data.error.code, 'TENANT_SUSPENDED');

  // Resuming clears it straight away — the cache invalidation contract.
  await tenantService.resume('suspended-shop');
  const resumed = await api('/t/suspended-shop');
  assert.notEqual(resumed.status, 423);
});

test('an unknown slug answers 404, never a redirect', async () => {
  const res = await api('/t/no-such-shop-at-all');
  assert.equal(res.status, 404);
  assert.equal(res.data.error.code, 'NOT_FOUND');

  const apiRes = await api('/t/no-such-shop-at-all/api/auth/me');
  assert.equal(apiRes.status, 404);
});

// ------------------------------------------------------------------------ 4
test('a tenant session and a platform session are never accepted by the other side', async () => {
  // A platform account with a password this test controls — the real
  // "owner" account's one-time password is only ever printed, never
  // returned to the caller, by design.
  const testPassword = 'platform-test-password-1';
  await platformDb().prepare(`
    INSERT INTO platform_users (username, password_hash, full_name, is_active, created_at)
    VALUES ('test-owner', ?, 'Test Owner', 1, ?)
  `).run(bcrypt.hashSync(testPassword, 4), new Date().toISOString());

  const platformLogin = await api('/api/platform/auth/login', {
    method: 'POST',
    body: { username: 'test-owner', password: testPassword },
  });
  assert.equal(platformLogin.status, 200);

  const tenant = await provisionTenant('cross-cookie-shop', 'Cross Cookie Shop');

  const platformToken = cookieValue(platformLogin.cookie);
  const tenantToken = cookieValue(tenant.cookie);

  // The platform's JWT, presented as the ERP's session cookie.
  const rejectedAsTenant = await api('/t/cross-cookie-shop/api/auth/me', {
    cookie: `mm_session=${platformToken}`,
  });
  assert.equal(rejectedAsTenant.status, 401);

  // The tenant's JWT, presented as the platform's session cookie.
  const rejectedAsPlatform = await api('/api/platform/tenants', {
    cookie: `mm_platform=${tenantToken}`,
  });
  assert.equal(rejectedAsPlatform.status, 401);

  // Sanity check: each token is perfectly valid on its own, correct side.
  const okPlatform = await api('/api/platform/auth/me', { cookie: platformLogin.cookie });
  assert.equal(okPlatform.status, 200);
  const okTenant = await api('/t/cross-cookie-shop/api/auth/me', { cookie: tenant.cookie });
  assert.equal(okTenant.status, 200);
});

// ------------------------------------------------------------------------ 5
test('migrate-all reports per tenant; one broken tenant does not stop the rest', async () => {
  await tenantService.create({
    slug: 'fleet-good', nameEn: 'Fleet Good', nameAr: 'Fleet Good', modules: [], websiteEnabled: true,
  });
  await tenantService.create({
    slug: 'fleet-broken', nameEn: 'Fleet Broken', nameAr: 'Fleet Broken', modules: [], websiteEnabled: true,
  });
  // Point the row at a path that cannot possibly be opened — no such
  // directory exists to create the file in.
  await platformDb().prepare('UPDATE tenants SET db_file = ? WHERE slug = ?')
    .run('/no/such/directory/on/this/machine/broken.db', 'fleet-broken');
  await forgetTenant('fleet-broken');

  const results = await migrateAllTenants();
  const broken = results.find((r) => r.slug === 'fleet-broken');
  const good = results.filter((r) => r.slug !== 'fleet-broken');

  assert.ok(broken, 'the broken tenant is still reported, not silently dropped');
  assert.ok(broken.error, 'and it carries an error');
  assert.ok(good.length >= 1, 'other tenants were still processed');
  for (const r of good) assert.equal(r.error, null, `${r.slug} migrated cleanly`);
});

// ------------------------------------------------------------------------ 6
test('tenant-import copies the source database and leaves the original untouched', async () => {
  const sourcePath = path.join(testDataDir, 'import-source.db');
  const sourceConnection = await openConnection({ driver: 'sqlite', file: sourcePath });
  await runWithTenant({ slug: 'import-source' }, sourceConnection, async () => {
    await sourceConnection.applySchema();
    await runMigrations();
    await seedBaseline();
  });
  await sourceConnection.close();

  const before = fs.statSync(sourcePath);

  const output = execFileSync(process.execPath, [
    path.join(here, '..', 'scripts', 'tenant-import.js'),
    '--file', sourcePath,
    '--slug', 'imported-shop',
    '--name', 'Imported Shop',
  ], {
    env: {
      ...process.env,
      MM_PLATFORM_DB: process.env.MM_PLATFORM_DB,
      MM_TENANTS_DIR: process.env.MM_TENANTS_DIR,
    },
    encoding: 'utf8',
  });

  const after = fs.statSync(sourcePath);
  assert.equal(after.mtimeMs, before.mtimeMs, 'the source file\'s mtime is unchanged');
  assert.equal(after.size, before.size, 'the source file\'s byte length is unchanged');

  const copiedPath = path.join(config.platform.tenantsDir, 'imported-shop.db');
  assert.ok(fs.existsSync(copiedPath), 'the copy exists in the tenants directory');
  assert.match(output, /user\(s\)/, 'the summary reports what was read back from the copy');

  // The registration itself is visible from this process too — a separate
  // process wrote it, so this also proves the control-plane file is really
  // shared, not per-process state.
  await forgetTenant('imported-shop');
  const tenant = await tenantService.get('imported-shop');
  assert.equal(tenant.status, 'active');
  assert.equal(tenant.modules.length > 0, true, 'every module is enabled on import');
});
