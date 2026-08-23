/**
 * The third writer: a shop's own traffic refreshing its own summary.
 *
 * The hourly sweep is the guarantee, and the console's button is the rebuild.
 * This is the one in between, and it is the only writer that exists on a
 * deployment with no `CRON_SECRET` — so it has to work, and it has to be
 * invisible to the shop it runs inside. Two properties, and they pull against
 * each other, which is why they are tested together:
 *
 *   - a summary that has gone stale IS refreshed by the shop's own traffic;
 *   - a shop that has never been summarised is NOT summarised by its traffic.
 *     Its first figures should be the ones the console computes when somebody
 *     first opens it, not whatever happened to be true at the moment a cashier
 *     signed in — and a till has no business writing a row nobody has asked for.
 *
 * And the third, which is the rule the whole thing lives under: the request
 * itself must not wait for any of it. The work is scheduled from the response's
 * `finish` event, so the assertion is that the summary is still old when the
 * response arrives and new shortly afterwards.
 *
 * `MM_FLEET_SUMMARY_STALE_MS` is turned right down so "stale" is reachable
 * inside a test. It is the same constant the deployment uses.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const testDataDir = path.join(here, '..', 'data', 'platform-onrequest-test');

fs.rmSync(testDataDir, { recursive: true, force: true });
fs.mkdirSync(path.join(testDataDir, 'tenants'), { recursive: true });

process.env.MM_PLATFORM = '1';
process.env.MM_PLATFORM_DB = path.join(testDataDir, 'platform.db');
process.env.MM_TENANTS_DIR = path.join(testDataDir, 'tenants');
process.env.MM_DB_FILE = path.join(testDataDir, 'unused-default.db');
/** Half a second stands in for three hours. */
process.env.MM_FLEET_SUMMARY_STALE_MS = '500';

const { createApp } = await import('../src/server.js');
const conn = await import('../src/infrastructure/database/connection.js');
const { initPlatformDb, closePlatformDb, platformDb } = await import('../src/platform/db.js');
const tenantService = (await import('../src/platform/TenantService.js')).default;
const summaries = (await import('../src/platform/FleetSummaryService.js')).default;

let base = '';
let server = null;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

before(async () => {
  await conn.initDb();
  await initPlatformDb();
  const app = createApp();
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  await tenantService.create({ slug: 'busy', nameEn: 'Busy Shop', nameAr: 'Busy Shop', modules: [] });
  await tenantService.create({ slug: 'quiet', nameEn: 'Quiet Shop', nameAr: 'Quiet Shop', modules: [] });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await conn.closeDb();
  await closePlatformDb();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

/** A storefront request: unauthenticated, tenant-scoped, ordinary shop traffic. */
const traffic = (slug) => fetch(`${base}/t/${slug}/api/shop/config`);

const summaryOf = (slug) => platformDb()
  .prepare('SELECT * FROM tenant_summaries WHERE slug = ?').get(slug);

/** Wait for the background write, which is deliberately not awaited anywhere. */
async function settle(fn, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
}

// ---------------------------------------------------------------------- 1
test('a shop\'s own traffic refreshes a summary that has gone stale, once between all of it', async () => {
  // Give it one, the way the console's first look would.
  const row = await platformDb().prepare('SELECT * FROM tenants WHERE slug = ?').get('busy');
  await summaries.refreshShop(row, { source: 'cron' });
  const written = await summaryOf('busy');
  assert.ok(written.computed_at, 'the shop has a summary to begin with');

  // Age it past the threshold.
  const old = new Date(Date.now() - 60_000).toISOString();
  await platformDb().prepare('UPDATE tenant_summaries SET computed_at = ?, attempted_at = ? WHERE slug = ?')
    .run(old, old, 'busy');

  /**
   * Ten at once, which is what a shop being used looks like. Every one of them
   * has to be answered, and between them they may cause exactly one refresh —
   * the per-slug claim in `noteTenantRequest` is made before the response even
   * finishes, so a burst schedules one piece of work rather than ten.
   *
   * (The stronger property — that not one byte of this happens before the
   * response is written — is structural rather than observable from here: the
   * work is scheduled from the response's own `finish` event, and against a
   * local SQLite file it completes faster than a `fetch` promise resolves. What
   * this file can show is that it happens, that it happens once, and that the
   * shop never stops answering while it does; test 3 covers the cost.)
   */
  const responses = await Promise.all(Array.from({ length: 10 }, () => traffic('busy')));
  assert.ok(responses.every((r) => r.status === 200), 'every request was answered');

  const refreshed = await settle(async () => (await summaryOf('busy')).computed_at !== old);
  assert.ok(refreshed, 'the shop\'s own traffic refreshed it once the responses were out');

  const now = await summaryOf('busy');
  assert.equal(now.source, 'request', 'and the row says who wrote it');
  assert.ok(Date.parse(now.computed_at) > Date.parse(old));

  // Nothing more, however long we wait: the window is claimed for the whole
  // staleness period the moment the first request looks at it.
  const settled = now.computed_at;
  await sleep(300);
  assert.equal((await summaryOf('busy')).computed_at, settled,
    'ten concurrent requests caused one refresh between them, not ten');
});

// ---------------------------------------------------------------------- 2
test('a shop with no summary is never given one by its own traffic', async () => {
  assert.equal(await summaryOf('quiet'), null, 'nothing has summarised this shop');

  for (let i = 0; i < 3; i += 1) {
    assert.equal((await traffic('quiet')).status, 200);
    await sleep(120);
  }
  await sleep(400);

  assert.equal(await summaryOf('quiet'), null,
    'a till does not write a row nobody has asked for — the console\'s first look does');

  // And the console's first look does exactly that.
  const data = await summaries.overview();
  assert.equal(data.shops.find((s) => s.slug === 'quiet').measured, true);
  assert.equal((await summaryOf('quiet')).source, 'backfill');
});

// ---------------------------------------------------------------------- 3
test('a fresh summary is left alone however much traffic the shop takes', async () => {
  const row = await platformDb().prepare('SELECT * FROM tenants WHERE slug = ?').get('busy');
  await summaries.refreshShop(row, { source: 'cron' });
  const before = await summaryOf('busy');

  // Enough requests that a per-request writer would be obvious.
  for (let i = 0; i < 15; i += 1) await traffic('busy');
  await sleep(400);

  const after = await summaryOf('busy');
  assert.equal(after.computed_at, before.computed_at,
    'the till is not taxed with a summary write per request');
  assert.equal(after.source, 'cron');
});
