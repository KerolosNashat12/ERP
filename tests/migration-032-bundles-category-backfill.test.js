/**
 * Migration 032 — the "Bundles" category, for a shop that already existed
 * when 031 shipped.
 *
 * ── The outage this file is the fence for ───────────────────────────────
 * Migration 031 added the columns and the `bundle_items` table a bundle
 * needs, but never inserted the "Bundles" category row itself — it relied
 * on `seedBaseline()`, which only ever runs once, at initial shop creation.
 * Every shop that already existed when 031 shipped got the new columns and
 * table, and never got the category row, because nothing in 031 inserted
 * one and `seedBaseline()` does not run again on an existing shop.
 *
 * The result, in production: `CatalogService#bundlesCategoryId` threw "The
 * Bundles category has not been set up on this shop yet" the moment anyone
 * on an existing shop tried to save their first bundle — not a missing
 * feature, a missing row.
 *
 * ── What is asserted here ────────────────────────────────────────────────
 *  - the real-world state is reproduced first (a shop migrated through 031,
 *    with no "Bundles" category row — see windBack below) rather than
 *    asserted from a mock, so this test would have caught the actual bug;
 *  - running migrations again backfills the row, without anybody pressing
 *    anything, the same guarantee `tenant-schema-drift.test.js` proves for
 *    an ordinary column;
 *  - the backfill is safe to run twice (`ON CONFLICT DO NOTHING`), so a
 *    shop that already has the row — including a brand new one, seeded with
 *    it from the start — is untouched;
 *  - and, end to end, a shop in the broken state can actually save a bundle
 *    once migrations have run again — the same request the owner made that
 *    failed live.
 */
import './single-shop.js'; // must be first — see that file
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'data', 'migration-032-test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
process.env.MM_DB_FILE = path.join(dir, 'shop.db');

const { createApp } = await import('../src/server.js');
const {
  initDb, closeDb, applySchema, getDb,
} = await import('../src/infrastructure/database/connection.js');
const { seedBaseline } = await import('../src/infrastructure/database/seed.js');
const { runMigrations } = await import('../src/infrastructure/database/migrations/index.js');

const bundlesCategory = () => getDb()
  .prepare("SELECT * FROM categories WHERE code = 'BUNDLES'").get();

/**
 * Wind a freshly-seeded shop back to exactly the state an existing shop was
 * in the instant 031 finished running: the row `seedBaseline()` would have
 * inserted for a brand-new shop is gone (an existing shop's `seedBaseline()`
 * never ran again to add it), and 032 has not run yet either.
 */
async function windBackToPre032() {
  const db = getDb();
  await db.prepare("DELETE FROM categories WHERE code = 'BUNDLES'").run();
  await db.prepare("DELETE FROM schema_migrations WHERE name = '032-bundles-category-backfill'").run();
}

test('migration 032 backfills the Bundles category for an existing shop', async (t) => {
  await initDb();
  await applySchema();
  await seedBaseline();
  await runMigrations(); // the shop's real first boot: 001..032, including 032 as a no-op

  const server = await new Promise((resolve) => {
    const l = http.createServer(createApp()).listen(0, '127.0.0.1', () => resolve(l));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const cookie = (await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  }).then((r) => r.headers.get('set-cookie'))) || '';

  const call = async (pathname, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { cookie } : {}),
        'Idempotency-Key': `m32-${Math.random().toString(36).slice(2)}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data };
  };
  const ok = async (p, o) => {
    const r = await call(p, o);
    assert.ok(r.status < 400, `${p} → ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
    return r.data;
  };

  await t.test('the fixture really is the real thing: the row is gone, same as an old shop', async () => {
    assert.ok(await bundlesCategory(), 'sanity check — a freshly seeded shop has the row to begin with');
    await windBackToPre032();
    assert.equal(await bundlesCategory(), null);
  });

  await t.test('one migration pass is enough to put it back', async () => {
    const ran = await runMigrations();
    assert.ok(ran.includes('032-bundles-category-backfill'));
    const row = await bundlesCategory();
    assert.ok(row, 'the Bundles category must exist after migrations run');
    assert.equal(row.name_en, 'Bundles');
    assert.equal(row.is_published, 1);
  });

  await t.test('running it again is a no-op, not a duplicate or an error', async () => {
    await assert.doesNotReject(() => getDb().prepare(`
      INSERT INTO categories (code, name_en, name_ar, is_published, display_order)
      VALUES ('BUNDLES', 'Bundles', 'باقات', 1, 0)
      ON CONFLICT(code) DO NOTHING
    `).run());
    const rows = await getDb().prepare("SELECT COUNT(*) AS n FROM categories WHERE code = 'BUNDLES'").get();
    assert.equal(rows.n, 1);
  });

  await t.test('a shop in the previously-broken state can now actually save a bundle', async () => {
    const p1 = await ok('/api/products', {
      method: 'POST',
      body: {
        sku_prefix: 'M32-A', name_en: 'M32-A', name_ar: 'M32-A',
        base_cost: 10, base_price: 40, is_active: true, track_inventory: true, is_published: true,
      },
    });
    const p2 = await ok('/api/products', {
      method: 'POST',
      body: {
        sku_prefix: 'M32-B', name_en: 'M32-B', name_ar: 'M32-B',
        base_cost: 10, base_price: 40, is_active: true, track_inventory: true, is_published: true,
      },
    });

    // Before the fix, this exact request is what threw BUSINESS_RULE /
    // "The Bundles category has not been set up on this shop yet".
    const bundle = await ok('/api/products', {
      method: 'POST',
      body: {
        sku_prefix: 'M32-SET', name_en: 'M32 Set', name_ar: 'M32 Set', base_price: 0,
        is_active: true, track_inventory: true, is_published: true,
        is_bundle: true, bundle_price_mode: 'sum',
        bundle_components: [
          { component_variant_id: p1.variants[0].id, quantity: 1 },
          { component_variant_id: p2.variants[0].id, quantity: 1 },
        ],
        attribute_ids: [], variants: [],
      },
    });
    assert.equal(bundle.category_id, (await bundlesCategory()).id);
  });
});
