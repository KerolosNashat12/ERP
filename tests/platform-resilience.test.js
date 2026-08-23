/**
 * The control plane goes away, and the shops keep trading.
 *
 * Every request on this platform resolves its shop through one database. When
 * that database blinked, nothing resolved — not a till mid-sale, not a customer
 * mid-checkout. `api/middleware/tenant.js` now keeps a descriptor it has read
 * successfully and serves it when a read FAILS, within a bounded window. This
 * file is the proof that the bound is real in both directions: a shop that was
 * open stays open, and a shop that was closed does not come back.
 *
 * ── How the outage is produced ───────────────────────────────────────────────
 * Not a stub, and not a mocked module. The `slug` column that every tenant
 * lookup reads is renamed out from under the query, so `SELECT * FROM tenants
 * WHERE slug = ?` fails inside the real driver, on the real connection, exactly
 * as it fails when the database at the other end of that connection is gone —
 * and renaming it back is a real recovery. Nothing about the code under test
 * knows this is a test.
 *
 * ── Both drivers ─────────────────────────────────────────────────────────────
 * The control plane runs on **libsql** (`MM_PLATFORM_DB_URL`, a `file:` URL —
 * the same client, statements and error shapes a hosted Turso control plane
 * uses), because a hosted control plane is the one that can actually become
 * unreachable. The shops underneath it are one of each: a `sqlite` file shop and
 * a `libsql` shop, and every assertion below is made against both.
 *
 * The two windows are shortened through the environment so the test can walk
 * past the second one in seconds rather than in a quarter of an hour. They are
 * the same two constants the deployment uses; nothing else is changed.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const testDataDir = path.join(here, '..', 'data', 'platform-resilience-test');

fs.rmSync(testDataDir, { recursive: true, force: true });
fs.mkdirSync(testDataDir, { recursive: true });

const fileUrl = (name) => `file:${path.join(testDataDir, name)}`;

process.env.MM_PLATFORM = '1';
process.env.MM_PLATFORM_DB_URL = fileUrl('control-plane.db');
process.env.MM_DB_FILE = path.join(testDataDir, 'unused-default.db');
process.env.MM_TENANTS_DIR = path.join(testDataDir, 'tenants');
/** Short enough that a stale entry is reached in one `await`, not fifteen seconds. */
process.env.MM_TENANT_CACHE_MS = '120';
/** The bound under test. Two and a half seconds stands in for fifteen minutes. */
process.env.MM_TENANT_GRACE_MS = '2500';
/** Nothing here is about summaries; keep the shops' traffic off that path. */
process.env.MM_FLEET_SUMMARY_ON_REQUEST = '0';

const { createApp } = await import('../src/server.js');
const { initDb, closeDb } = await import('../src/infrastructure/database/connection.js');
const { initPlatformDb, closePlatformDb, platformDb } = await import('../src/platform/db.js');
const tenantService = (await import('../src/platform/TenantService.js')).default;
const { forgetTenant } = await import('../src/api/middleware/tenant.js');
const config = (await import('../src/config/index.js')).default;

const GRACE_MS = Number(process.env.MM_TENANT_GRACE_MS);
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

let base = '';
let server = null;

/** One shop on each driver, so every assertion below is made twice. */
const SHOPS = [
  { key: 'sqlite', slug: 'file-shop', database: undefined },
  { key: 'libsql', slug: 'hosted-shop', database: () => ({ mode: 'libsql', url: fileUrl('hosted-shop.db') }) },
];

before(async () => {
  // The same guard platform-hosted.test.js keeps: if the URL is ever not
  // honoured, every test below would quietly run against a developer's own
  // control plane. Refuse to run instead.
  assert.equal(config.platform.driver, 'libsql',
    'the control plane must be the hosted driver — refusing to run against a local file');

  await initDb();
  await initPlatformDb();
  const app = createApp();
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  for (const shop of SHOPS) {
    await tenantService.create({
      slug: shop.slug,
      nameEn: `${shop.key} shop`,
      nameAr: `${shop.key} shop`,
      modules: [],
      websiteEnabled: true,
      ...(shop.database ? { database: shop.database() } : {}),
    });
  }
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await closeDb();
  await closePlatformDb();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

async function get(urlPath) {
  const res = await fetch(`${base}${urlPath}`);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

/**
 * The storefront's own config route: unauthenticated, tenant-scoped, and the
 * closest thing in this codebase to "a customer is standing in front of this
 * shop right now". If it answers, the shop is trading.
 */
const trade = (slug) => get(`/t/${slug}/api/shop/config`);

/** Rename the one column every tenant lookup reads. See the file header. */
async function breakControlPlane() {
  await platformDb().prepare('ALTER TABLE tenants RENAME COLUMN slug TO slug_unreachable').run();
}

async function fixControlPlane() {
  await platformDb().prepare('ALTER TABLE tenants RENAME COLUMN slug_unreachable TO slug').run();
}

/**
 * Ask once and throw the answer away, so the next request is the one that has
 * to go to the control plane. The TTL is 120ms here; anything older than that
 * is a read.
 */
async function warm(slug) {
  const res = await trade(slug);
  assert.equal(res.status, 200, `${slug} is trading before the outage`);
  await sleep(160);
  return res;
}

// ---------------------------------------------------------------------- 1
test('a shop that resolved a moment ago keeps trading while the control plane is unreachable', async () => {
  for (const shop of SHOPS) {
    await warm(shop.slug);
    await breakControlPlane();
    try {
      const res = await trade(shop.slug);
      assert.equal(res.status, 200,
        `${shop.key}: the shop is still trading with the control plane unreachable`);

      // And it says so, on the answer itself, without a console login.
      assert.equal(res.headers.get('x-mm-tenant-source'), 'remembered');
      assert.equal(res.headers.get('x-mm-control-plane'), 'degraded');
      assert.ok(Number(res.headers.get('x-mm-tenant-age')) >= 0,
        'the age of the descriptor is on the response in seconds');

      // The whole instance says so too, unauthenticated — which matters,
      // because the control plane being down is what stops anybody signing in.
      const health = await get('/api/health');
      assert.equal(health.status, 200, 'health is up even when the control plane is not');
      assert.equal(health.data.controlPlane.state, 'degraded');
      assert.ok(health.data.controlPlane.remembered >= 1,
        'health reports how many shops this instance could still serve');
      assert.equal(health.data.controlPlane.graceMs, GRACE_MS);
      // Counts and timestamps only — never a slug, a message or a URL.
      assert.doesNotMatch(JSON.stringify(health.data), new RegExp(shop.slug));
      assert.doesNotMatch(JSON.stringify(health.data), /file:/);
    } finally {
      await fixControlPlane();
    }

    // Back on the control plane the moment it answers again — no cool-down.
    const after = await trade(shop.slug);
    assert.equal(after.status, 200);
    assert.equal(after.headers.get('x-mm-tenant-source'), 'fresh');
    assert.equal(after.headers.get('x-mm-control-plane'), null,
      'nothing is flagged degraded once the control plane answers');
  }

  // The outage is on the record, written when the control plane could be
  // written to again — which is the only moment it could have been.
  const rows = await platformDb()
    .prepare("SELECT detail FROM platform_audit WHERE action = 'CONTROL_PLANE_RECOVERED' ORDER BY id").all();
  assert.ok(rows.length >= 1, 'a recovered control plane leaves one audit row per outage');
  const detail = JSON.parse(rows.at(-1).detail);
  assert.ok(detail.servedFromMemory >= 1, 'the row says how many requests were served from memory');
  assert.ok(detail.durationMs >= 0 && detail.startedAt && detail.endedAt);
  assert.doesNotMatch(JSON.stringify(rows), /file:/, 'no database URL is ever in an audit row');
});

// ---------------------------------------------------------------------- 2
test('absence is never invented: an unknown shop is 503 during an outage, not 404', async () => {
  // Healthy, the answer is the one it has always been.
  const known = await get('/t/no-such-shop-here/api/shop/config');
  assert.equal(known.status, 404, 'a typo is a 404 while the control plane answers');

  await warm(SHOPS[0].slug);
  await breakControlPlane();
  try {
    const res = await get('/t/no-such-shop-here/api/shop/config');
    assert.equal(res.status, 503,
      'a 404 claims a shop does not exist, and an instance that cannot read the control plane does not know that');
    assert.equal(res.data.error.code, 'CONTROL_PLANE_UNAVAILABLE');
    assert.ok(Number(res.headers.get('retry-after')) > 0, 'a 503 always says when to come back');

    // A shop this instance HAS resolved is unaffected by the same outage.
    const trading = await trade(SHOPS[0].slug);
    assert.equal(trading.status, 200);
  } finally {
    await fixControlPlane();
  }
});

// ---------------------------------------------------------------------- 3
test('a suspended shop does not go on trading past the grace window', async () => {
  for (const shop of SHOPS) {
    await warm(shop.slug);

    /**
     * Suspended straight in the database, with no `forgetTenant`. That is
     * precisely what a suspension made on ANOTHER serverless instance looks
     * like from here: the row changed, and this process was never told.
     */
    await platformDb().prepare("UPDATE tenants SET status = 'suspended' WHERE slug = ?").run(shop.slug);
    await breakControlPlane();
    const suspendedAt = Date.now();

    try {
      // Inside the window the shop is still trading — that is the trade this
      // whole design makes, and it is deliberate.
      const during = await trade(shop.slug);
      assert.equal(during.status, 200, `${shop.key}: still trading inside the grace window`);
      assert.equal(during.headers.get('x-mm-tenant-source'), 'remembered');

      // Past it, it stops. Not 200, and not a made-up status either: this
      // instance no longer knows what the shop's status is, and 503 is what
      // "I cannot tell you" looks like.
      await sleep(Math.max(0, GRACE_MS - (Date.now() - suspendedAt)) + 250);
      const after = await trade(shop.slug);
      assert.equal(after.status, 503,
        `${shop.key}: a remembered descriptor is not served past the grace window`);
      assert.equal(after.data.error.code, 'CONTROL_PLANE_UNAVAILABLE');
    } finally {
      await fixControlPlane();
    }

    // And once the control plane answers, the suspension is what it always was.
    const settled = await trade(shop.slug);
    assert.equal(settled.status, 423, `${shop.key}: suspended, read from the control plane`);
    assert.equal(settled.data.error.code, 'TENANT_SUSPENDED');

    await platformDb().prepare("UPDATE tenants SET status = 'active' WHERE slug = ?").run(shop.slug);
    await forgetTenant(shop.slug);
  }
});

// ---------------------------------------------------------------------- 4
test('a refusal is never overturned from memory', async () => {
  const { slug } = SHOPS[0];

  // Suspend it properly, and let this instance learn it.
  await tenantService.suspend(slug);
  const closed = await trade(slug);
  assert.equal(closed.status, 423, 'suspended while the control plane answers');

  await breakControlPlane();
  try {
    const during = await trade(slug);
    assert.equal(during.status, 423,
      'a shop that is suspended stays suspended when the refusal cannot be confirmed');
    assert.equal(during.data.error.code, 'TENANT_SUSPENDED');
  } finally {
    await fixControlPlane();
  }

  await tenantService.resume(slug);
  assert.equal((await trade(slug)).status, 200, 'resumed the moment the control plane says so');
});

// ---------------------------------------------------------------------- 5
test('a website switched off stays off through an outage, and a suspension made here is not resurrected by one', async () => {
  const { slug } = SHOPS[1];

  await tenantService.update(slug, { websiteEnabled: false });
  assert.equal((await trade(slug)).status, 404, 'the storefront is closed');

  await breakControlPlane();
  try {
    assert.equal((await trade(slug)).status, 404,
      'a closed door is not opened because the control plane cannot be asked');
  } finally {
    await fixControlPlane();
  }
  await tenantService.update(slug, { websiteEnabled: true });
  assert.equal((await trade(slug)).status, 200);

  /**
   * The other half of the same rule, and the reason `forgetTenant` drops the
   * remembered copy as well as the cached one: a suspension made on THIS
   * instance must not be undone by the next wobble, which is exactly what would
   * happen if the descriptor it was suspended from were still in memory.
   */
  await warm(slug);
  await tenantService.suspend(slug);
  await breakControlPlane();
  try {
    const res = await trade(slug);
    assert.notEqual(res.status, 200,
      'the descriptor this shop was suspended from is gone, not waiting in memory');
    assert.equal(res.status, 503);
  } finally {
    await fixControlPlane();
  }
  await tenantService.resume(slug);
});

// ---------------------------------------------------------------------- 6
test('the healthy path is unchanged: a cache hit still costs no control-plane read', async () => {
  const { slug } = SHOPS[0];
  const first = await trade(slug);
  assert.equal(first.status, 200);

  // Straight away, inside the TTL: served from the cache, and labelled as such.
  const second = await trade(slug);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('x-mm-tenant-source'), 'cached');
  assert.equal(second.headers.get('x-mm-control-plane'), null);

  const health = await get('/api/health');
  assert.equal(health.data.controlPlane.state, 'ok');
  assert.equal(health.data.controlPlane.ttlMs, 120);
});
