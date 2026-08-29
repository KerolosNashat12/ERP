/**
 * THE SHOOT LIST — which products still need a photograph, and in what order.
 *
 * This exists because the owner asked, four times, for product photographs to
 * be downloaded from the internet. They cannot be: the pictures of a named
 * product belong to whoever shot them, and a generic stock bottle on a product
 * page is worse than an empty frame — a customer orders the thing in the
 * picture and returns the thing in the box.
 *
 * So the answer is to make HIS photographs cheap. The cost was never the
 * shooting, it was the navigation: find a bare product, open it, scroll to the
 * photo card, upload, go back, remember where you were, two hundred times.
 *
 * The ORDER is therefore the feature, and it is what most of this file tests.
 * A list sorted by id scatters one supplier's products through it and turns
 * one pass along a shelf into two hundred round trips.
 */
import './single-shop.js'; // must be first — see that file
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'data', 'shoot-test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
process.env.MM_DB_FILE = path.join(dir, 'shop.db');

const { createApp } = await import('../src/server.js');
const { initDb, closeDb, applySchema } = await import('../src/infrastructure/database/connection.js');
const { seedBaseline } = await import('../src/infrastructure/database/seed.js');
const { runMigrations } = await import('../src/infrastructure/database/migrations/index.js');

let base = '';
let cookie = '';
const call = async (pathname, { method = 'GET', body } = {}) => {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
      'Idempotency-Key': `sl-${Math.random().toString(36).slice(2)}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
};
const ok = async (p, o) => {
  const r = await call(p, o);
  assert.ok(r.status < 400, `${p} → ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  return r.data;
};
const list = () => ok('/api/products/without-photos?limit=500');

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('the shoot list', async (t) => {
  await initDb();
  await applySchema();
  await seedBaseline();
  await runMigrations();

  const server = await new Promise((resolve) => {
    const l = http.createServer(createApp()).listen(0, '127.0.0.1', () => resolve(l));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  cookie = (await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  }).then((r) => r.headers.get('set-cookie'))).split(';')[0];

  /*
   * Two brands, interleaved on purpose: created alternately so that anything
   * sorted by id comes back A, B, A, B. If the list is grouped, that ordering
   * has to be undone — which is the whole point and cannot be observed on a
   * fixture that was already in brand order.
   */
  const dior = await ok('/api/brands', { method: 'POST', body: { name_en: 'Aaa Dior', name_ar: 'ديور' } });
  const tom = await ok('/api/brands', { method: 'POST', body: { name_en: 'Zzz Tom Ford', name_ar: 'توم فورد' } });
  const made = [];
  for (let i = 0; i < 6; i += 1) {
    const brand = i % 2 === 0 ? dior : tom;
    // eslint-disable-next-line no-await-in-loop
    made.push(await ok('/api/products', {
      method: 'POST',
      body: {
        sku_prefix: `SH-${i}`, name_en: `Item ${i}`, name_ar: `صنف ${i}`,
        brand_id: brand.id, base_price: 100, is_published: 1,
        variants: [{ sku: `SH-${i}-A`, cost_price: 10, selling_price: 100 }],
      },
    }));
  }

  await t.test('the queue is grouped by brand, not left in id order', async () => {
    const { rows } = await list();
    const mine = rows.filter((r) => r.code.startsWith('SH-')).map((r) => r.brand_en);
    // Every run of one brand must be contiguous: a brand may not reappear
    // after a different one has been seen.
    const seen = [];
    for (const brand of mine) {
      if (seen[seen.length - 1] !== brand) {
        assert.ok(!seen.includes(brand),
          `${brand} appears again after another brand — the walk is not grouped: ${mine.join(', ')}`);
        seen.push(brand);
      }
    }
    assert.equal(seen.length, 2, `expected two brand runs, got ${JSON.stringify(seen)}`);
  });

  await t.test('a product with a photograph leaves the list', async () => {
    const before = await list();
    const target = before.rows.find((r) => r.code === 'SH-0');
    assert.ok(target, 'the fixture is not in the list to begin with');

    await ok(`/api/products/${target.id}/images`, { method: 'POST', body: { dataUrl: PIXEL } });

    const after = await list();
    assert.ok(!after.rows.some((r) => r.code === 'SH-0'),
      'a photographed product is still being offered to be photographed');
    assert.equal(after.remaining, before.remaining - 1,
      'the count of what is left did not move');
  });

  await t.test('a product with no brand goes last, not first', async () => {
    /*
     * It cannot be grouped with anything, so it belongs at the end where it
     * does not break a walk along the shelves. Sorted naively it would lead the
     * list, because NULL sorts first.
     */
    await ok('/api/products', {
      method: 'POST',
      body: {
        sku_prefix: 'SH-NOBRAND', name_en: 'Aaaa Orphan', name_ar: 'يتيم',
        base_price: 10, is_published: 1,
        variants: [{ sku: 'SH-NOBRAND-A', cost_price: 1, selling_price: 10 }],
      },
    });
    const { rows } = await list();
    const at = rows.findIndex((r) => r.code === 'SH-NOBRAND');
    assert.ok(at >= 0, 'the orphan is not in the list at all');
    assert.equal(at, rows.length - 1,
      `a product with no brand is at position ${at + 1} of ${rows.length}, not last`);
  });

  await t.test('an inactive product is not worth standing in front of', async () => {
    const target = made[1];
    await ok(`/api/products/${target.id}`, {
      method: 'PUT',
      body: {
        sku_prefix: target.sku_prefix, name_en: target.name_en, name_ar: target.name_ar,
        brand_id: target.brand_id, base_price: 100, is_active: 0,
        variants: [{ id: target.variants[0].id, sku: target.variants[0].sku, cost_price: 10, selling_price: 100 }],
      },
    });
    const { rows } = await list();
    assert.ok(!rows.some((r) => r.code === target.sku_prefix),
      'a stopped product is still on the shoot list');
  });

  await t.test('an UNPUBLISHED product IS on the list, and says so', async () => {
    /*
     * Different from inactive. A product that is simply not on the website yet
     * is very often not on it BECAUSE it has no photograph — it is exactly what
     * somebody doing a photo session is trying to fix. So it stays, and the row
     * carries `is_published` so the screen can say why it matters.
     */
    const target = made[2];
    await ok(`/api/products/${target.id}`, {
      method: 'PUT',
      body: {
        sku_prefix: target.sku_prefix, name_en: target.name_en, name_ar: target.name_ar,
        brand_id: target.brand_id, base_price: 100, is_published: 0,
        variants: [{ id: target.variants[0].id, sku: target.variants[0].sku, cost_price: 10, selling_price: 100 }],
      },
    });
    const { rows } = await list();
    const row = rows.find((r) => r.code === target.sku_prefix);
    assert.ok(row, 'an unpublished product was dropped from the shoot list');
    assert.equal(Number(row.is_published), 0, 'the row does not say it is off the website');
  });

  await t.test('`remaining` is the whole job, not the page', async () => {
    /*
     * The screen shows "12 of 248". If `remaining` counted only what was
     * loaded, the bar would reach 100% and then start again — worse than no
     * bar at all.
     */
    const page = await ok('/api/products/without-photos?limit=2');
    assert.equal(page.rows.length, 2, 'the limit was ignored');
    assert.ok(page.remaining > 2,
      `remaining (${page.remaining}) should count the whole shop, not the page`);
  });

  await t.test('a stranger cannot read the shop\'s catalogue through it', async () => {
    const res = await fetch(`${base}/api/products/without-photos`);
    assert.equal(res.status, 401);
    // The control: with a session it answers, so the assertion is about the
    // session and not about a broken route.
    assert.equal((await call('/api/products/without-photos')).status, 200);
  });
});
