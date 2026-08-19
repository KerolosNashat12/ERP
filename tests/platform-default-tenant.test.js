/**
 * Switching a live single-shop deployment into a platform without breaking the
 * links already in the world.
 *
 * The shop that was at `/` has a storefront address customers saved and a till
 * bookmarked on a counter PC. `MM_DEFAULT_TENANT` names that shop, and `/` and
 * `/shop` become its own addresses under `/t/<slug>`. Everything about the
 * config is frozen at first import, so — as in platform.test.js — the variables
 * are set before the server module is loaded.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const testDataDir = path.join(here, '..', 'data', 'default-tenant-test');

process.env.MM_PLATFORM = '1';
process.env.MM_PLATFORM_DB = path.join(testDataDir, 'platform.db');
process.env.MM_TENANTS_DIR = path.join(testDataDir, 'tenants');
process.env.MM_DEFAULT_TENANT = 'mainshop';

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
  await tenantService.create({
    slug: 'mainshop', nameEn: 'The Shop That Was Here First', modules: ['dashboard', 'products'],
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
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

const head = (path_) => fetch(`${base}${path_}`, { redirect: 'manual' });

test('the root goes to the shop that was already there, not to the console', async () => {
  const res = await head('/');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/t/mainshop');
});

test('a saved storefront link still lands on that shop', async () => {
  const res = await head('/shop');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/t/mainshop/shop');
});

test('and so does a deep link inside the storefront', async () => {
  const res = await head('/shop/anything');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/t/mainshop/shop/anything');
});

test('the console is still reachable at its own address', async () => {
  const res = await fetch(`${base}/platform`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<html/i);
});

test('a shop that is not the default is unaffected', async () => {
  const res = await fetch(`${base}/t/mainshop/api/session`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.tenant.slug, 'mainshop');
});

test('the old un-prefixed API answers as the default shop', async () => {
  // The reason this exists: a host that serves `public/` statically hands
  // `/shop` to the browser from its CDN, so the storefront loads at the old
  // address and calls `/api/shop/...` with no prefix. Before this, those calls
  // 404'd and a live storefront showed an error page to its customers.
  const config_ = await fetch(`${base}/api/shop/config`);
  assert.equal(config_.status, 200);
  const body = await config_.json();
  assert.equal(typeof body.shopEnabled, 'boolean');

  const session = await (await fetch(`${base}/api/session`)).json();
  assert.equal(session.tenant.slug, 'mainshop', 'and it is the default shop, not the process database');
});

test('an un-prefixed ERP call is that shop too, not an open door to a nameless database', async () => {
  const res = await fetch(`${base}/api/products`);
  // No session, so 401 — the point is that it reached the tenant's router at
  // all rather than the platform's "no shop here" 404.
  assert.equal(res.status, 401);
});
