/**
 * Section 4 of the platform contract, exercised over real HTTP:
 *   - module entitlements enforced inside `requirePermission`
 *   - the check cannot be bypassed by a route that accepts several codes
 *   - `max_users` / `max_products` limits
 *   - the website switch (404 on `/api/shop/*` and no storefront HTML)
 *   - `GET /api/session`
 *
 * Same environment-variable-before-import dance as `platform.test.js`: the
 * Node test runner gives this file its own process, so setting MM_PLATFORM
 * here cannot leak into the single-shop suites.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const testDataDir = path.join(here, '..', 'data', 'entitlements-test');

process.env.MM_PLATFORM = '1';
process.env.MM_PLATFORM_DB = path.join(testDataDir, 'platform.db');
process.env.MM_TENANTS_DIR = path.join(testDataDir, 'tenants');
// No default shop in this process: these tests are about a fleet where every
// shop is addressed by slug, and `platform.json` names one for the deployment.
process.env.MM_DEFAULT_TENANT = '';

fs.rmSync(testDataDir, { recursive: true, force: true });
fs.mkdirSync(testDataDir, { recursive: true });

const { createApp } = await import('../src/server.js');
const { initDb, closeDb } = await import('../src/infrastructure/database/connection.js');
const { initPlatformDb, closePlatformDb } = await import('../src/platform/db.js');
const tenantService = (await import('../src/platform/TenantService.js')).default;

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
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie');
  const contentType = res.headers.get('content-type') || '';
  const text = await res.text();
  let data;
  if (contentType.includes('application/json')) {
    try { data = JSON.parse(text); } catch { data = text; }
  } else {
    data = text;
  }
  return {
    status: res.status, data, contentType, cookie: setCookie ? setCookie.split(';')[0] : cookie,
  };
}

let seq = 0;
/** A fresh slug per call, so tenants never collide across tests in this file. */
function slugFor(label) {
  seq += 1;
  return `ent-${label}-${seq}`;
}

async function provisionTenant(label, opts = {}) {
  const slug = slugFor(label);
  const provisioned = await tenantService.create({
    slug,
    nameEn: `Entitlements ${label}`,
    nameAr: `Entitlements ${label}`,
    modules: opts.modules || [],
    limits: opts.limits || {},
    websiteEnabled: opts.websiteEnabled !== false,
  });
  const login = await api(`/t/${slug}/api/auth/login`, {
    method: 'POST',
    body: { username: provisioned.adminUsername, password: provisioned.adminPassword },
  });
  assert.equal(login.status, 200, `tenant ${slug} admin can sign in with the one-time password`);
  return { slug, cookie: login.cookie };
}

/** Creates a user under `role` (by role code) and signs them in. */
async function createUserWithRole(slug, adminCookie, roleCode, username) {
  const roles = await api(`/t/${slug}/api/users/roles`, { cookie: adminCookie });
  const role = roles.data.rows.find((r) => r.code === roleCode);
  assert.ok(role, `role "${roleCode}" exists in the catalogue`);

  const created = await api(`/t/${slug}/api/users`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      username, full_name: username, password: 'password123', role_id: role.id,
    },
  });
  assert.equal(created.status, 201, `user ${username} created`);

  const login = await api(`/t/${slug}/api/auth/login`, {
    method: 'POST',
    body: { username, password: 'password123' },
  });
  assert.equal(login.status, 200);
  return login.cookie;
}

function newProductBody(prefix) {
  return {
    sku_prefix: `${prefix}-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 1000)}`,
    name_en: `${prefix} product`,
    base_cost: 5,
    base_price: 10,
    tax_rate: 0,
    attribute_ids: [],
    variants: [],
  };
}

// ---------------------------------------------------------------- module gate

test('a tenant without the purchases module gets 403 MODULE_NOT_ENABLED; one with it does not — same route, same role', async () => {
  const without = await provisionTenant('no-purchases', { modules: [] });
  const withIt = await provisionTenant('has-purchases', { modules: ['purchases'] });

  const blocked = await api(`/t/${without.slug}/api/purchases`, { cookie: without.cookie });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.error.code, 'MODULE_NOT_ENABLED');
  assert.equal(blocked.data.error.module, 'purchases');

  const allowed = await api(`/t/${withIt.slug}/api/purchases`, { cookie: withIt.cookie });
  assert.equal(allowed.status, 200);
  assert.ok(Array.isArray(allowed.data.rows));
});

test('the module check cannot be bypassed by a route that accepts several permissions', async () => {
  // /promotions/evaluate is `requirePermission('sales.create', 'promotions.view')`.
  // The accountant role has `promotions.view` but not `sales.create`, so the
  // permission that actually grants access here is `promotions.view` — a
  // check that (wrongly) looked at the module of `codes[0]` ('sales') would
  // let a tenant with `sales` enabled but `promotions` disabled through,
  // even though the permission that matched belongs to the disabled module.
  const salesOnly = await provisionTenant('bypass-sales', { modules: ['sales', 'users'] });
  const accountantOnSalesOnly = await createUserWithRole(
    salesOnly.slug, salesOnly.cookie, 'accountant', 'accountant1',
  );
  const stillBlocked = await api(`/t/${salesOnly.slug}/api/promotions/evaluate`, {
    method: 'POST',
    cookie: accountantOnSalesOnly,
    body: { code: 'NOPE', lines: [] },
  });
  assert.equal(stillBlocked.status, 403, 'blocked even though "sales" (codes[0]\'s module) is enabled');
  assert.equal(stillBlocked.data.error.code, 'MODULE_NOT_ENABLED');
  assert.equal(stillBlocked.data.error.module, 'promotions');

  // Flip it: promotions enabled, sales disabled — the same accountant now
  // gets past the gate (and fails downstream on a promotion code that does
  // not exist, proving the request really reached the service).
  const promotionsOnly = await provisionTenant('bypass-promotions', { modules: ['promotions', 'users'] });
  const accountantOnPromotionsOnly = await createUserWithRole(
    promotionsOnly.slug, promotionsOnly.cookie, 'accountant', 'accountant1',
  );
  const passedGate = await api(`/t/${promotionsOnly.slug}/api/promotions/evaluate`, {
    method: 'POST',
    cookie: accountantOnPromotionsOnly,
    body: { code: 'NOPE', lines: [] },
  });
  assert.equal(passedGate.status, 404, 'past the module gate — fails downstream on the unknown code');
  assert.equal(passedGate.data.error.code, 'NOT_FOUND');
});

test('in platform mode the bare API is closed — every shop is addressed by slug', async () => {
  // The single-shop behaviour of `requirePermission` (no tenant, no module
  // check) is covered by the whole of smoke.test.js, which runs in a process
  // with the platform switched off. What this process can prove is the other
  // half: once the platform is on, the un-prefixed API no longer answers for
  // the process default database, so there is no way to reach a shop except
  // by naming it.
  const res = await api('/api/session');
  assert.equal(res.status, 404);
  assert.equal(res.data.error.code, 'NOT_FOUND');
});

// -------------------------------------------------------------------- limits

test('max_users refuses the user that would exceed it and allows the one before it', async () => {
  const tenant = await provisionTenant('user-limit', { modules: ['users'], limits: { maxUsers: 2 } });

  const roles = await api(`/t/${tenant.slug}/api/users/roles`, { cookie: tenant.cookie });
  const cashierRole = roles.data.rows.find((r) => r.code === 'cashier');

  // Seat 1 is the admin created by provisioning. This is seat 2 — allowed.
  const second = await api(`/t/${tenant.slug}/api/users`, {
    method: 'POST',
    cookie: tenant.cookie,
    body: {
      username: 'seat-two', full_name: 'Seat Two', password: 'password123', role_id: cashierRole.id,
    },
  });
  assert.equal(second.status, 201, 'the user that fills the last seat is allowed');

  // A third would exceed the limit of 2.
  const third = await api(`/t/${tenant.slug}/api/users`, {
    method: 'POST',
    cookie: tenant.cookie,
    body: {
      username: 'seat-three', full_name: 'Seat Three', password: 'password123', role_id: cashierRole.id,
    },
  });
  assert.equal(third.status, 400);
  assert.equal(third.data.error.code, 'BUSINESS_RULE');
  assert.match(third.data.error.message, /2/);

  // Deactivating seat two does not free it — an inactive account still
  // occupies a seat, so a third creation is still refused.
  const seatTwoId = second.data.id;
  const deactivate = await api(`/t/${tenant.slug}/api/users/${seatTwoId}`, {
    method: 'PUT',
    cookie: tenant.cookie,
    body: {
      full_name: 'Seat Two', role_id: cashierRole.id, is_active: false,
    },
  });
  assert.equal(deactivate.status, 200);

  const stillThird = await api(`/t/${tenant.slug}/api/users`, {
    method: 'POST',
    cookie: tenant.cookie,
    body: {
      username: 'seat-three-again', full_name: 'Seat Three', password: 'password123', role_id: cashierRole.id,
    },
  });
  assert.equal(stillThird.status, 400, 'an inactive user still occupies its seat');
  assert.equal(stillThird.data.error.code, 'BUSINESS_RULE');
  assert.match(stillThird.data.error.message, /inactive/i);
});

test('max_products refuses the product that would exceed it and allows the one before it', async () => {
  const tenant = await provisionTenant('product-limit', { modules: ['products'], limits: { maxProducts: 1 } });

  const first = await api(`/t/${tenant.slug}/api/products`, {
    method: 'POST', cookie: tenant.cookie, body: newProductBody('FIRST'),
  });
  assert.equal(first.status, 201, 'the product that fills the last slot is allowed');

  const second = await api(`/t/${tenant.slug}/api/products`, {
    method: 'POST', cookie: tenant.cookie, body: newProductBody('SECOND'),
  });
  assert.equal(second.status, 400);
  assert.equal(second.data.error.code, 'BUSINESS_RULE');
  assert.match(second.data.error.message, /1/);

  // Editing the one product that exists must never trip the limit.
  const edit = await api(`/t/${tenant.slug}/api/products/${first.data.id}`, {
    method: 'PUT', cookie: tenant.cookie, body: { ...newProductBody('FIRST'), name_en: 'Renamed' },
  });
  assert.equal(edit.status, 200, 'editing the existing product is unaffected by the limit');
});

test('0 means unlimited for both max_users and max_products', async () => {
  const tenant = await provisionTenant('unlimited', {
    modules: ['products', 'users'], limits: { maxUsers: 0, maxProducts: 0 },
  });
  const roles = await api(`/t/${tenant.slug}/api/users/roles`, { cookie: tenant.cookie });
  const cashierRole = roles.data.rows.find((r) => r.code === 'cashier');

  for (let i = 0; i < 3; i += 1) {
    const created = await api(`/t/${tenant.slug}/api/users`, {
      method: 'POST',
      cookie: tenant.cookie,
      body: {
        username: `unlimited-${i}`, full_name: `U ${i}`, password: 'password123', role_id: cashierRole.id,
      },
    });
    assert.equal(created.status, 201);
  }
  for (let i = 0; i < 3; i += 1) {
    const created = await api(`/t/${tenant.slug}/api/products`, {
      method: 'POST', cookie: tenant.cookie, body: newProductBody(`UNLIM${i}`),
    });
    assert.equal(created.status, 201);
  }
});

// ---------------------------------------------------------------- website off

test('a website-disabled tenant answers 404 on the shop API and serves no storefront HTML', async () => {
  const off = await provisionTenant('website-off', { modules: ['products'], websiteEnabled: false });
  const on = await provisionTenant('website-on', { modules: ['products'], websiteEnabled: true });

  const config = await api(`/t/${off.slug}/api/shop/config`);
  assert.equal(config.status, 404);
  assert.equal(config.data.error.code, 'NOT_FOUND');

  // Every route under the shop API, not just /config.
  const home = await api(`/t/${off.slug}/api/shop/home`);
  assert.equal(home.status, 404);
  const trackOrder = await api(`/t/${off.slug}/api/shop/orders/ANY-1?phone=0100000000`);
  assert.equal(trackOrder.status, 404);

  // The storefront's own HTML shell must not be served either.
  const storefrontPage = await api(`/t/${off.slug}/shop`);
  assert.equal(storefrontPage.status, 404);
  assert.ok(
    !String(storefrontPage.data).includes('<html'),
    'no HTML document comes back for a website-disabled tenant',
  );
  // Nor by reaching the same file straight through the static server.
  const directFile = await api(`/t/${off.slug}/shop/index.html`);
  assert.equal(directFile.status, 404);

  // The control: an otherwise-identical tenant with the website on gets a
  // real config payload and a real HTML document.
  const onConfig = await api(`/t/${on.slug}/api/shop/config`);
  assert.equal(onConfig.status, 200);
  const onPage = await api(`/t/${on.slug}/shop`);
  assert.equal(onPage.status, 200);
  assert.ok(String(onPage.data).includes('<html'));
});

// -------------------------------------------------------------------- session

test('GET /api/session carries the tenant\'s slug, name, modules and website flag', async () => {
  const tenant = await provisionTenant('session-check', {
    modules: ['products', 'sales'], websiteEnabled: false,
  });

  const res = await api(`/t/${tenant.slug}/api/session`);
  assert.equal(res.status, 200);
  assert.equal(res.data.tenant.slug, tenant.slug);
  assert.equal(res.data.tenant.name, `Entitlements session-check`);
  assert.deepEqual([...res.data.tenant.modules].sort(), ['products', 'sales']);
  assert.equal(res.data.tenant.websiteEnabled, false);
});

// The `tenant: null` shape a single shop sees is asserted in smoke.test.js,
// which runs with the platform switched off — the only honest place to test it.
