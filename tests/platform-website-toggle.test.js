/**
 * Switching a shop's website off and on again.
 *
 * This is the bug that took a live storefront down twice. Two halves:
 *
 *   1. off means off, and looks like nothing is there — a 404 in the shape the
 *      router uses for a path that does not exist, not a 403 that would confirm
 *      a shop is behind the door;
 *   2. on means on again *everywhere*, within a bounded time. A serverless
 *      deployment runs many instances; the one that handled the toggle knows,
 *      and the others have to find out by their cache expiring. A change made
 *      straight into the control plane — which is exactly what another instance
 *      looks like from here — must become visible without restarting anything.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'data', 'website-toggle-test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

process.env.MM_PLATFORM = '1';
process.env.MM_PLATFORM_DB = path.join(dir, 'platform.db');
process.env.MM_TENANTS_DIR = path.join(dir, 'tenants');
process.env.MM_DB_FILE = path.join(dir, 'root.db');
process.env.MM_DEFAULT_TENANT = 'shopone';
// Short enough to assert against without a slow test; production leaves the default.
process.env.MM_TENANT_CACHE_MS = '400';

const { createApp } = await import('../src/server.js');
const { initDb, applySchema, closeDb } = await import('../src/infrastructure/database/connection.js');
const { initPlatformDb, closePlatformDb, platformDb } = await import('../src/platform/db.js');
const tenantService = (await import('../src/platform/TenantService.js')).default;

let base = '';
let server = null;

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

before(async () => {
  await initDb();
  await applySchema();
  await initPlatformDb();
  await tenantService.create({
    slug: 'shopone',
    nameEn: 'Shop One',
    modules: ['dashboard', 'products', 'sales'],
    websiteEnabled: true,
  });
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

const get = (p) => fetch(`${base}${p}`);

test('the storefront answers on both addresses while the website is on', async () => {
  for (const p of ['/api/shop/config', '/t/shopone/api/shop/config']) {
    const res = await get(p);
    assert.equal(res.status, 200, p);
    assert.equal((await res.json()).shopEnabled, true);
  }
});

test('switching it off closes both, and says nothing about what is behind', async () => {
  await tenantService.update('shopone', { websiteEnabled: false });

  for (const p of ['/api/shop/config', '/t/shopone/api/shop/config', '/api/shop/products']) {
    const res = await get(p);
    assert.equal(res.status, 404, p);
    const body = await res.json();
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.doesNotMatch(JSON.stringify(body), /suspend|disabled|website/i, 'and does not explain itself');
  }

  const html = await get('/t/shopone/shop');
  assert.equal(html.status, 404, 'nor is the storefront page served');
});

test('switching it back on brings the shop back', async () => {
  await tenantService.update('shopone', { websiteEnabled: true });
  const res = await get('/api/shop/config');
  assert.equal(res.status, 200);
});

test('the ERP is untouched by the website switch either way', async () => {
  await tenantService.update('shopone', { websiteEnabled: false });
  const session = await get('/api/session');
  assert.equal(session.status, 200, 'the till keeps working while the website is off');
  assert.equal((await session.json()).tenant.slug, 'shopone');
  await tenantService.update('shopone', { websiteEnabled: true });
});

test('a change made by another instance is picked up when the cache expires', async () => {
  // Prime this instance's cache first: the point being proved is that a stale
  // entry is both served *and* eventually replaced, and an empty cache would
  // prove only the second half by accident.
  assert.equal((await get('/api/shop/config')).status, 200);

  // Written straight into the control plane, with no invalidation — which is
  // precisely what a second serverless instance's write looks like from here.
  await platformDb().prepare("UPDATE tenants SET website_enabled = 0 WHERE slug = 'shopone'").run();

  const immediately = await get('/api/shop/config');
  assert.equal(immediately.status, 200, 'the cached answer is still served for now');

  await wait(Number(process.env.MM_TENANT_CACHE_MS) + 150);

  const later = await get('/api/shop/config');
  assert.equal(later.status, 404, 'and the new answer arrives without a restart');

  await platformDb().prepare("UPDATE tenants SET website_enabled = 1 WHERE slug = 'shopone'").run();
  await wait(Number(process.env.MM_TENANT_CACHE_MS) + 150);
  assert.equal((await get('/api/shop/config')).status, 200, 'and back again, both directions');
});

test('suspending and resuming behaves the same way across instances', async () => {
  await platformDb().prepare("UPDATE tenants SET status = 'suspended' WHERE slug = 'shopone'").run();
  await wait(Number(process.env.MM_TENANT_CACHE_MS) + 150);
  assert.equal((await get('/t/shopone/api/session')).status, 423);

  await platformDb().prepare("UPDATE tenants SET status = 'active' WHERE slug = 'shopone'").run();
  await wait(Number(process.env.MM_TENANT_CACHE_MS) + 150);
  assert.equal((await get('/t/shopone/api/session')).status, 200);
});

test('a stale "off" cannot close a shop that is actually open', async () => {
  // The failure this whole cache is now shaped around: another instance turned
  // the website back on, this one still believes it is off, and a customer is
  // standing in front of the storefront. The gate must ask before refusing.
  await tenantService.update('shopone', { websiteEnabled: false });
  assert.equal((await get('/api/shop/config')).status, 404, 'off is off');

  // Straight into the control plane: no invalidation, exactly like another
  // instance switching it back on.
  await platformDb().prepare("UPDATE tenants SET website_enabled = 1 WHERE slug = 'shopone'").run();

  const immediately = await get('/api/shop/config');
  assert.equal(immediately.status, 200, 'and the shop is open again on the very next request, not after a wait');
});
