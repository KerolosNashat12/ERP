/**
 * The fleet overview is READ, not computed.
 *
 * `FleetService.overviewLive()` builds the owner's landing screen by opening
 * every shop's database. At six shops that is fine; at eighty it is eighty
 * connections on a metered database, every page load. The overview now reads
 * one control-plane table instead, and this file is the proof that it really
 * does — not that it produces the same numbers, which a slow implementation
 * would also do, but that **no shop's database is opened at all**.
 *
 * The way that is proved is deliberately brutal: once the summaries are
 * written, every shop's database is pointed at a path that cannot be opened. A
 * page that still shows their figures cannot have gone near them. A page that
 * flags them unreachable has, and the test fails.
 *
 * Everything runs twice, once per shop driver — `sqlite` on a file and `libsql`
 * on a `file:` URL, which is the same client, statement encoding and row
 * decoding a hosted Turso shop uses.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const testDataDir = path.join(here, '..', 'data', 'platform-summaries-test');

fs.rmSync(testDataDir, { recursive: true, force: true });
fs.mkdirSync(path.join(testDataDir, 'tenants'), { recursive: true });

process.env.MM_PLATFORM = '1';
process.env.MM_PLATFORM_DB = path.join(testDataDir, 'platform.db');
process.env.MM_TENANTS_DIR = path.join(testDataDir, 'tenants');
process.env.MM_DB_FILE = path.join(testDataDir, 'unused-default.db');
/** The sweep's own authorisation, so the cron route can be exercised for real. */
process.env.CRON_SECRET = 'summaries-test-cron-secret';

const { createApp } = await import('../src/server.js');
const conn = await import('../src/infrastructure/database/connection.js');
const { initPlatformDb, closePlatformDb, platformDb } = await import('../src/platform/db.js');
const tenantService = (await import('../src/platform/TenantService.js')).default;
const summaries = (await import('../src/platform/FleetSummaryService.js')).default;
const { MODULES } = await import('../src/shared/permissions.js');
const { forgetTenant } = await import('../src/api/middleware/tenant.js');

const fileUrl = (name) => `file:${path.join(testDataDir, 'tenants', name)}`;

let base = '';
let server = null;
let owner = '';

/** One shop on each driver, plus the ones each test makes for itself. */
const SHOPS = [
  { slug: 'sum-file', driver: 'sqlite', sales: 3, each: 100 },
  { slug: 'sum-hosted', driver: 'libsql', sales: 2, each: 250 },
];

before(async () => {
  await conn.initDb();
  await initPlatformDb();
  const app = createApp();
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  const password = 'summaries-test-owner-password';
  await platformDb().prepare(`
    INSERT INTO platform_users (username, password_hash, full_name, is_active, created_at)
    VALUES ('sum-owner', ?, 'Summary Owner', 1, ?)
  `).run(bcrypt.hashSync(password, 4), new Date().toISOString());
  const login = await api('/api/platform/auth/login', {
    method: 'POST', body: { username: 'sum-owner', password },
  });
  assert.equal(login.status, 200);
  owner = login.cookie;

  for (const shop of SHOPS) {
    await tenantService.create({
      slug: shop.slug,
      nameEn: `${shop.slug} shop`,
      nameAr: `${shop.slug} shop`,
      modules: Object.keys(MODULES),
      ...(shop.driver === 'libsql'
        ? { database: { mode: 'libsql', url: fileUrl(`${shop.slug}.db`) } }
        : {}),
    });
    await sell(shop);
  }
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await conn.closeDb();
  await closePlatformDb();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

async function api(urlPath, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
      'Idempotency-Key': `s-${Math.random().toString(36).slice(2)}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, cookie: setCookie ? setCookie.split(';')[0] : cookie };
}

async function ok(urlPath, options = {}) {
  const res = await api(urlPath, { ...options, cookie: owner });
  assert.ok(res.status >= 200 && res.status < 300,
    `${options.method || 'GET'} ${urlPath} -> ${res.status} ${JSON.stringify(res.data)}`);
  return res.data;
}

/** A tenant's own connection, from its control-plane row. */
async function openShop(slug) {
  const row = await platformDb().prepare('SELECT * FROM tenants WHERE slug = ?').get(slug);
  return conn.openConnection({
    driver: row.driver || 'sqlite', file: row.db_file, url: row.db_url, authToken: row.db_auth_token,
  });
}

/** Invoices written straight in, so the figures under test have a known value. */
async function sell(shop) {
  const c = await openShop(shop.slug);
  await conn.runWithTenant({ slug: shop.slug }, c, async () => {
    for (let i = 1; i <= shop.sales; i += 1) {
      await c.facade.prepare(`
        INSERT INTO sales (invoice_no, warehouse_id, status, sale_date, subtotal, tax_amount,
                           total_amount, total_cost, paid_amount, payment_method, created_by)
        VALUES (?, 1, 'completed', ?, ?, 0, ?, 0, ?, 'cash', 1)
      `).run(`INV-${shop.slug}-${i}`, new Date().toISOString(), shop.each, shop.each, shop.each);
    }
  });
  await c.close();
}

const expected = (shop) => shop.sales * shop.each;

/** Point a shop's database at a path that can never be opened. */
async function unplug(slug) {
  await platformDb().prepare('UPDATE tenants SET driver = ?, db_file = ?, db_url = NULL WHERE slug = ?')
    .run('sqlite', '/no/such/directory/on/this/machine/gone.db', slug);
  await forgetTenant(slug);
}

async function replug(slug, driver, file, url) {
  await platformDb().prepare('UPDATE tenants SET driver = ?, db_file = ?, db_url = ? WHERE slug = ?')
    .run(driver, file, url, slug);
  await forgetTenant(slug);
}

async function descriptorOf(slug) {
  return platformDb().prepare('SELECT driver, db_file, db_url FROM tenants WHERE slug = ?').get(slug);
}

// ---------------------------------------------------------------------- 1
test('the overview reads summaries — with every shop database unplugged, the figures are still there', async () => {
  // The first read of a shop that has never been measured backfills it, which
  // is the only time this page opens a database at all.
  const first = await ok('/api/platform/overview');
  assert.equal(first.summary.source, 'summaries');
  for (const shop of SHOPS) {
    const row = first.shops.find((r) => r.slug === shop.slug);
    assert.equal(row.measured, true, `${shop.slug} was measured on the first look`);
    assert.equal(row.revenue30d, expected(shop));
    assert.ok(row.summaryAt, 'and the row says when');
  }

  // Now take every shop's database away. Nothing that opens one can succeed.
  const before = new Map();
  for (const shop of SHOPS) {
    before.set(shop.slug, await descriptorOf(shop.slug));
    await unplug(shop.slug);
  }

  try {
    const read = await ok('/api/platform/overview');
    for (const shop of SHOPS) {
      const row = read.shops.find((r) => r.slug === shop.slug);
      assert.equal(row.error, false,
        `${shop.slug}: the page did not open this database, so it cannot have failed to`);
      assert.equal(row.revenue30d, expected(shop), `${shop.slug}: the figures came from the table`);
      assert.equal(row.measured, true);
    }
    assert.equal(read.totals.unreachableShops, 0);

    // And the live fan-out, on the same unplugged fleet, says the opposite —
    // which is what proves the first assertion was not a coincidence.
    const live = await ok('/api/platform/overview?live=1');
    for (const shop of SHOPS) {
      const row = live.shops.find((r) => r.slug === shop.slug);
      assert.equal(row.error, true, `${shop.slug}: the fan-out really does open databases`);
      assert.equal(row.revenue30d, null);
    }
  } finally {
    for (const shop of SHOPS) {
      const d = before.get(shop.slug);
      await replug(shop.slug, d.driver, d.db_file, d.db_url);
    }
  }
});

// ---------------------------------------------------------------------- 2
test('a shop with no summary at all renders as "not measured", never as a zero', async () => {
  await tenantService.create({
    slug: 'sum-never', nameEn: 'Never Measured', nameAr: 'Never Measured', modules: [],
  });

  /**
   * `backfill: false` is the state a large fleet is genuinely in: the page
   * backfills at most a few never-measured shops per load, so on a fleet of
   * eighty fresh shops most of them render exactly like this until the sweep
   * reaches them.
   */
  const data = await summaries.overview({ backfill: false });
  const row = data.shops.find((r) => r.slug === 'sum-never');

  assert.equal(row.measured, false);
  assert.equal(row.revenue30d, null, 'null, not 0 — nobody has read this shop');
  assert.equal(row.orders30d, null);
  assert.equal(row.users, null);
  assert.equal(row.products, null);
  assert.equal(row.summaryAt, null);
  assert.equal(row.error, false, 'not measured is not the same as unreachable');

  // The things that are decisions rather than statistics are still there, live.
  assert.equal(row.status, 'active');
  assert.equal(row.name, 'Never Measured');
  assert.equal(row.websiteEnabled, true);

  // It is counted as unmeasured rather than folded into the totals as a zero,
  // and it sorts below every shop that has figures.
  assert.ok(data.totals.unmeasuredShops >= 1);
  assert.equal(data.summary.unmeasured, data.totals.unmeasuredShops);
  assert.equal(data.shops.at(-1).measured, false);

  // The whole fleet is still counted — an unmeasured shop is a shop.
  assert.equal(data.totals.shops, data.shops.length);
});

// ---------------------------------------------------------------------- 3
test('a suspended shop and a shop whose database has gone both render, and neither breaks the page', async () => {
  await tenantService.create({
    slug: 'sum-suspended', nameEn: 'Suspended Shop', nameAr: 'Suspended Shop', modules: [],
  });
  await tenantService.suspend('sum-suspended');

  await tenantService.create({
    slug: 'sum-gone', nameEn: 'Gone Shop', nameAr: 'Gone Shop', modules: [],
  });
  await unplug('sum-gone');

  const res = await api('/api/platform/overview', { cookie: owner });
  assert.equal(res.status, 200, 'the page renders');

  const suspended = res.data.shops.find((r) => r.slug === 'sum-suspended');
  assert.equal(suspended.status, 'suspended', 'read live from the control plane');
  assert.equal(suspended.error, false,
    'a suspended shop is still summarised — its figures are what the conversation about it needs');

  const gone = res.data.shops.find((r) => r.slug === 'sum-gone');
  assert.equal(gone.error, true);
  assert.equal(gone.errorMessage, 'This shop\'s database could not be read');
  assert.equal(gone.revenue30d, null, 'no figures were ever read, so there are none to show');
  assert.ok(gone.summaryAttemptedAt, 'but the moment of the failed read is on the row');
  assert.doesNotMatch(JSON.stringify(res.data), /no\/such\/directory/,
    'no database path, URL or token is ever echoed back');

  // A second load must not try it again — the failure is recorded, so the page
  // stays a single control-plane read however broken the fleet is.
  const again = await ok('/api/platform/overview');
  assert.equal(again.shops.find((r) => r.slug === 'sum-gone').error, true);
  assert.equal(again.summary.backfilled, 0, 'nothing was backfilled the second time');
});

// ---------------------------------------------------------------------- 4
test('an old summary is shown as old, and its last good figures are kept', async () => {
  const shop = SHOPS[0];
  const old = new Date(Date.now() - 9 * 3_600_000).toISOString();
  await platformDb().prepare('UPDATE tenant_summaries SET computed_at = ?, attempted_at = ? WHERE slug = ?')
    .run(old, old, shop.slug);

  const data = await summaries.overview({ backfill: false });
  const row = data.shops.find((r) => r.slug === shop.slug);
  assert.equal(row.stale, true, 'nine hours is past the staleness threshold');
  assert.equal(row.summaryAt, old, 'and the page is told exactly how old');
  assert.ok(row.summaryAgeMs > 8 * 3_600_000);
  assert.equal(row.revenue30d, expected(shop), 'the figures are still the last true ones');
  assert.ok(data.summary.stale >= 1);
  assert.equal(data.summary.staleAfterMs, summaries.STALE_MS);

  /**
   * "Today's takings" is not the same kind of number as a thirty-day window: a
   * figure computed on an earlier day is about the wrong day, not merely old,
   * so it is left out of the total rather than added to it.
   */
  await platformDb().prepare("UPDATE tenant_summaries SET computed_day = '2001-01-01', computed_month = '2001-01' WHERE slug = ?")
    .run(shop.slug);
  const yesterday = await summaries.overview({ backfill: false });
  const stale = yesterday.shops.find((r) => r.slug === shop.slug);
  assert.equal(stale.revenueToday, null, 'a figure about another day is not shown as today');
  assert.ok(yesterday.totals.todayShops < yesterday.totals.measuredShops,
    'and the page says how many shops today\'s total is actually made of');

  // Refreshing one shop puts it right again, and says who wrote it.
  await ok(`/api/platform/tenants/${shop.slug}/summary/refresh`, { method: 'POST' });
  const fixed = await summaries.overview({ backfill: false });
  const fresh = fixed.shops.find((r) => r.slug === shop.slug);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.summarySource, 'console');
  assert.equal(fresh.revenue30d, expected(shop));
});

// ---------------------------------------------------------------------- 5
test('the sweep refreshes the shops that need it, worst first, and is audited when a person asks for it', async () => {
  const unarmed = await api('/api/cron/summaries', { method: 'GET' });
  assert.equal(unarmed.status, 401, 'the sweep is not reachable without the secret');

  // Age every summary so the whole fleet is due.
  const old = new Date(Date.now() - 48 * 3_600_000).toISOString();
  await platformDb().prepare('UPDATE tenant_summaries SET computed_at = ?, attempted_at = ?').run(old, old);

  const res = await fetch(`${base}/api/cron/summaries`, {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(body.ran >= 2, `the sweep read the stale shops (${body.ran})`);
  assert.equal(body.remaining, 0);

  const after = await summaries.overview({ backfill: false });
  const swept = after.shops.find((r) => r.slug === SHOPS[1].slug);
  assert.equal(swept.stale, false, 'the sweep brought it back inside the window');
  assert.equal(swept.summarySource, 'cron', 'and the row says the sweep wrote it');
  assert.equal(swept.revenue30d, expected(SHOPS[1]));

  // A second sweep straight afterwards does nothing: fresh shops are skipped.
  const second = await (await fetch(`${base}/api/cron/summaries`, {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  })).json();
  assert.equal(second.ran, 0, 'an hourly sweep does not re-read what it just read');

  // "Refresh now" is the rebuild, and it is audited: it opens every shop's
  // database on purpose, and who did that should have an answer.
  const rebuilt = await ok('/api/platform/overview/refresh', { method: 'POST' });
  assert.ok(rebuilt.refreshed >= 2);
  assert.ok(rebuilt.overview.shops.length >= 2);
  const audit = await platformDb()
    .prepare("SELECT platform_user_id, detail FROM platform_audit WHERE action = 'FLEET_SUMMARY_REFRESH'").all();
  assert.ok(audit.length >= 1, 'rebuilding the fleet is audited');
  assert.ok(audit.at(-1).platform_user_id, 'by whom');
});

// ---------------------------------------------------------------------- 6
test('the summaries endpoint says whether anything is refreshing them, and is behind the owner session', async () => {
  const anonymous = await api('/api/platform/summaries');
  assert.equal(anonymous.status, 401);
  const anonymousRefresh = await api('/api/platform/overview/refresh', { method: 'POST' });
  assert.equal(anonymousRefresh.status, 401);

  const state = await ok('/api/platform/summaries');
  assert.equal(state.scheduleArmed, true, 'this deployment has a CRON_SECRET');
  assert.equal(state.source, 'summaries');
  assert.ok(state.shops.length >= 2);
  assert.ok(state.shops.every((s) => 'measured' in s && 'summaryAt' in s));
  // No figure leaks out of this endpoint — it is about freshness, not takings.
  assert.ok(state.shops.every((s) => !('revenue30d' in s)));
});

// ---------------------------------------------------------------------- 7
test('the fleet trend and the shop rows agree, and are built without opening a shop', async () => {
  await ok('/api/platform/overview/refresh', { method: 'POST' });
  const data = await ok('/api/platform/overview');

  const summed = data.shops
    .filter((s) => s.measured)
    .reduce((acc, s) => acc + s.revenue30d, 0);
  const trendTotal = data.trend.reduce((acc, p) => acc + p.revenue, 0);
  assert.equal(Math.round(trendTotal * 100), Math.round(summed * 100),
    'the fleet trend adds up to the shops it was summed from');
  assert.equal(data.trend.length, 30, 'thirty days, zero-filled, no holes in the axis');
});
