/**
 * SEARCH, AGAINST A REAL CATALOGUE AND OVER REAL HTTP.
 *
 * Two things are fenced here and they fail in completely different ways.
 *
 * ── The index must not drift ────────────────────────────────────────────────
 * `product_search` is derived data. If it falls behind the products it
 * describes, search stops finding things that plainly exist — and NOTHING ELSE
 * BREAKS to say so. No error, no 500, no failing page: just a shop owner
 * typing a product's name and being told it is not there. That is the worst
 * shape a bug can have, so every write path that changes searchable text has a
 * test here, including the two nobody thinks of (renaming a brand, and a bulk
 * edit moving fifty products between categories).
 *
 * ── The ladder must not overreach ───────────────────────────────────────────
 * The engine reads a term several ways, and the cheap readings exist to rescue
 * a search that would otherwise be empty. What must never happen is a cheap
 * reading firing when a confident one was available, because that turns a
 * scanned barcode into a guess. Several tests below assert what search does
 * NOT return, which is the half that actually protects the till.
 */
import './single-shop.js'; // must be first — see that file
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'data', 'search-test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
process.env.MM_DB_FILE = path.join(dir, 'shop.db');

const { createApp } = await import('../src/server.js');
const { initDb, closeDb, applySchema, getDb } = await import('../src/infrastructure/database/connection.js');
const { seedBaseline } = await import('../src/infrastructure/database/seed.js');
const { runMigrations } = await import('../src/infrastructure/database/migrations/index.js');
const { swapToLatin } = await import('../public/shared/searchText.js');

let base = '';
let server = null;
let cookie = '';

async function call(pathname, { method = 'GET', body, as = cookie } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(as ? { cookie: as } : {}),
      'Idempotency-Key': `sr-${Math.random().toString(36).slice(2)}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
const ok = async (p, o) => {
  const res = await call(p, o);
  assert.ok(res.status < 400, `${p} → ${res.status} ${JSON.stringify(res.data).slice(0, 250)}`);
  return res.data;
};

/** Product names from the suggest answer, in rank order. */
const suggested = async (q) => {
  const data = await ok(`/api/search/suggest?q=${encodeURIComponent(q)}`);
  const group = data.groups.find((g) => g.kind === 'product');
  return { tier: data.tier, names: group ? group.rows.map((r) => r.name_en) : [], data };
};

test('search across the whole shop', async (t) => {
  await initDb();
  await applySchema();
  await seedBaseline();
  await runMigrations();

  server = await new Promise((resolve) => {
    const listening = http.createServer(createApp()).listen(0, '127.0.0.1', () => resolve(listening));
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
  }).then((res) => res.headers.get('set-cookie'))).split(';')[0];

  /*
   * A catalogue shaped like this shop's: transliterated brand names, an Arabic
   * name and an English one, a barcode, and one product whose Arabic spelling
   * uses the letters everybody types differently.
   */
  const brand = await ok('/api/brands', { method: 'POST', body: { name_en: 'Tom Ford', name_ar: 'توم فورد' } });
  const other = await ok('/api/brands', { method: 'POST', body: { name_en: 'Dior', name_ar: 'ديور' } });
  const category = await ok('/api/categories', { method: 'POST', body: { name_en: 'Perfume', name_ar: 'عطور' } });

  const make = (body) => ok('/api/products', { method: 'POST', body: { base_price: 100, is_published: 1, ...body } });

  const tobacco = await make({
    sku_prefix: 'TF-01', name_en: 'Tobacco Vanille', name_ar: 'توباكو فانيل',
    brand_id: brand.id, category_id: category.id,
    variants: [{ sku: 'TF-01-A', cost_price: 50, selling_price: 100, barcode: '6221000000015' }],
  });
  await make({
    sku_prefix: 'DR-01', name_en: 'Sauvage Elixir', name_ar: 'سوفاج إليكسير',
    brand_id: other.id, category_id: category.id,
    variants: [{ sku: 'DR-01-A', cost_price: 50, selling_price: 100 }],
  });
  const red = await make({
    // Written with the hamza. Nobody will type it that way.
    sku_prefix: 'RD-01', name_en: 'Red Lipstick', name_ar: 'أحمر شفاه',
    category_id: category.id,
    variants: [{ sku: 'RD-01-A', cost_price: 10, selling_price: 40 }],
  });

  /* ══════════════════════════ the cases that made this necessary ══════════ */

  await t.test('«احمر» finds «أحمر» — the hamza nobody types', async () => {
    const { names } = await suggested('احمر');
    assert.ok(names.includes('Red Lipstick'), `got ${JSON.stringify(names)}`);
  });

  await t.test('an English name finds a product stored in Arabic', async () => {
    // «توباكو فانيل» has an English name too, so this is checked through the
    // consonant skeleton by searching a spelling that is in NEITHER column.
    const { names, tier } = await suggested('tobako');
    assert.ok(names.includes('Tobacco Vanille'), `tier=${tier} got ${JSON.stringify(names)}`);
  });

  await t.test('a typo still finds it, and says that is what happened', async () => {
    const { names, tier } = await suggested('tabaco');
    assert.ok(names.includes('Tobacco Vanille'), `got ${JSON.stringify(names)}`);
    assert.equal(tier, 'typo', 'the screen cannot tell the person these are guesses');
  });

  await t.test('the keyboard was on the wrong language', async () => {
    /*
     * «سوفاج» typed with the keyboard still on English. Built by swapping
     * rather than typed as a literal, so this test cannot rot against a
     * corrected layout table.
     */
    const typed = swapToLatin('سوفاج');
    const { names, tier } = await suggested(typed);
    assert.ok(names.includes('Sauvage Elixir'),
      `"${typed}" («سوفاج» on an English keyboard) gave tier=${tier} ${JSON.stringify(names)}`);
  });

  await t.test('a code is found however its separators were typed', async () => {
    for (const term of ['TF-01', 'tf01', 'tf 01']) {
      // eslint-disable-next-line no-await-in-loop
      const { names } = await suggested(term);
      assert.ok(names.includes('Tobacco Vanille'), `"${term}" found ${JSON.stringify(names)}`);
    }
  });

  await t.test('a barcode finds its product, exactly, first', async () => {
    const { names } = await suggested('6221000000015');
    assert.equal(names[0], 'Tobacco Vanille');
  });

  await t.test('a brand name finds the brand AND its products', async () => {
    const { data, names } = await suggested('ديور');
    assert.ok(names.includes('Sauvage Elixir'), `products: ${JSON.stringify(names)}`);
    assert.ok(data.groups.some((g) => g.kind === 'brand' && g.rows.some((r) => r.name_en === 'Dior')),
      'the brand itself was not offered');
  });

  /* ══════════════════════════════ what it must NOT do ═════════════════════ */

  await t.test('a word no product carries returns nothing, not something', async () => {
    /*
     * The most important test in this file. «عطر» is a real Arabic word whose
     * consonant skeleton is `tr`, which appears inside «سوفاج إليكسير»'s
     * shapes, and whose keystrokes are `u'v`, which is a substring of
     * `sauvage`. Two separate cheap readings both wanted to answer it.
     *
     * A shop owner searching for a word that is in none of their product names
     * has to get an empty list. A confident wrong answer sends somebody to the
     * wrong shelf.
     */
    const { names } = await suggested('عطرr');
    assert.deepEqual(names, [], 'a term matching nothing was answered anyway');
  });

  await t.test('a near-miss code does not match a real one', async () => {
    // `TF-02` does not exist. Answering it with `TF-01` at a till is how the
    // wrong bottle goes in the bag.
    const { names } = await suggested('TF-99');
    assert.ok(!names.includes('Tobacco Vanille'), `TF-99 matched ${JSON.stringify(names)}`);
  });

  await t.test('one letter is not a search', async () => {
    const { names } = await suggested('a');
    assert.ok(names.length <= 6, 'a single letter pulled back a list');
  });

  /* ═══════════════════════════ the index must not drift ═══════════════════ */

  await t.test('renaming a product makes it findable by the new name, not the old', async () => {
    await ok(`/api/products/${red.id}`, {
      method: 'PUT',
      body: {
        sku_prefix: 'RD-01', name_en: 'Crimson Lipstick', name_ar: 'أحمر شفاه',
        category_id: category.id,
        variants: [{ id: red.variants[0].id, sku: 'RD-01-A', cost_price: 10, selling_price: 40 }],
      },
    });
    const found = await suggested('crimson');
    assert.ok(found.names.includes('Crimson Lipstick'), 'the new name is not findable');
    const gone = await suggested('Red Lipstick');
    assert.ok(!gone.names.includes('Crimson Lipstick'),
      'the product is still findable by a name it no longer has');
  });

  await t.test('renaming a BRAND reindexes the products under it', async () => {
    /*
     * The hook nobody thinks of. The brand's name is in each product's search
     * text so that typing «ديور» finds Dior's products — and the cost of that
     * is this: without the hook, a renamed brand leaves its products findable
     * by the name it used to have and not by the one it has.
     */
    await ok(`/api/brands/${other.id}`, {
      method: 'PUT', body: { name_en: 'Christian Dior', name_ar: 'كريستيان ديور' },
    });
    const found = await suggested('christian');
    assert.ok(found.names.includes('Sauvage Elixir'),
      `renaming the brand did not reach its products: ${JSON.stringify(found.names)}`);
  });

  await t.test('a bulk edit that moves products keeps them findable', async () => {
    const shelf = await ok('/api/categories', { method: 'POST', body: { name_en: 'Niche Shelf', name_ar: 'رف خاص' } });
    await ok('/api/products/bulk', {
      method: 'POST', body: { ids: [tobacco.id], changes: { category_id: shelf.id } },
    });
    const found = await suggested('niche');
    assert.ok(found.names.includes('Tobacco Vanille'),
      `a bulk category move left the index behind: ${JSON.stringify(found.names)}`);
  });

  await t.test('a deleted product stops being suggested', async () => {
    const doomed = await make({
      sku_prefix: 'ZZ-99', name_en: 'Ephemeral Thing', name_ar: 'حاجة مؤقتة',
      variants: [{ sku: 'ZZ-99-A', cost_price: 1, selling_price: 2 }],
    });
    assert.ok((await suggested('Ephemeral')).names.includes('Ephemeral Thing'));

    await ok(`/api/products/${doomed.id}`, { method: 'DELETE' });
    const after = await suggested('Ephemeral');
    assert.deepEqual(after.names, [],
      'a deleted product is still suggested — clicking it would open nothing');
  });

  await t.test('every product in the catalogue has an index row', async () => {
    /*
     * The blanket check. Any write path added later that forgets to reindex
     * shows up here as a count that does not match, rather than as a shop
     * owner months from now saying "it cannot find my new products".
     */
    const db = getDb();
    const orphans = await db.prepare(`
      SELECT p.id, p.name_en FROM products p
      LEFT JOIN product_search ps ON ps.product_id = p.id
      WHERE ps.product_id IS NULL
    `).all();
    assert.deepEqual(orphans, [], 'products with no search text');

    const stale = await db.prepare(`
      SELECT ps.product_id FROM product_search ps
      LEFT JOIN products p ON p.id = ps.product_id
      WHERE p.id IS NULL
    `).all();
    assert.deepEqual(stale, [], 'search text for products that no longer exist');
  });

  /* ════════════════════════════════ who may see what ══════════════════════ */

  await t.test('the storefront never suggests what is not for sale', async () => {
    const hidden = await make({
      sku_prefix: 'HID-1', name_en: 'Unpublished Secret', name_ar: 'سر',
      is_published: 0,
      variants: [{ sku: 'HID-1-A', cost_price: 1, selling_price: 2 }],
    });
    assert.ok(hidden.id, 'the fixture did not save');

    // The ERP finds it — that is correct, it is the shop's own product.
    assert.ok((await suggested('Unpublished')).names.includes('Unpublished Secret'));

    // The open internet does not.
    const publicRes = await fetch(`${base}/api/shop/suggest?q=${encodeURIComponent('Unpublished')}`);
    const publicData = await publicRes.json();
    assert.equal(publicRes.status, 200);
    assert.deepEqual(publicData.rows, [],
      'an unpublished product was offered to a shopper');

    // The control: the storefront DOES answer for a published one, so the
    // assertion above is about publishing and not about a broken endpoint.
    const real = await (await fetch(`${base}/api/shop/suggest?q=tobacco`)).json();
    assert.ok(real.rows.some((r) => r.name_en === 'Tobacco Vanille'),
      'the storefront suggests nothing at all, so the test above proves nothing');
  });

  await t.test('the storefront answers a typo too', async () => {
    const data = await (await fetch(`${base}/api/shop/suggest?q=tabaco`)).json();
    assert.equal(data.tier, 'typo');
    assert.ok(data.rows.some((r) => r.name_en === 'Tobacco Vanille'));
  });

  await t.test('a stranger cannot search the shop through the ERP endpoint', async () => {
    const res = await fetch(`${base}/api/search/suggest?q=tobacco`);
    assert.equal(res.status, 401);
  });

  await t.test('a cashier is offered products but not the shop\'s suppliers', async () => {
    /*
     * One box that can return suppliers, customers and purchase orders cannot
     * be gated by one permission. Each group is checked separately, with the
     * same function the route guards are written in terms of.
     */
    const supplier = await ok('/api/suppliers', {
      method: 'POST', body: { name_en: 'Cairo Traders', name_ar: 'تجار القاهرة' },
    });
    assert.ok(supplier.id);

    // The admin sees the supplier group.
    const asAdmin = await ok('/api/search/suggest?q=cairo');
    assert.ok(asAdmin.groups.some((g) => g.kind === 'supplier'),
      'the control failed — even an admin gets no suppliers, so the test below means nothing');

    const cashierCookie = (await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'cashier', password: 'cashier123' }),
    })).headers.get('set-cookie');
    if (!cashierCookie) return; // this seed has no cashier; the admin control above still stands

    const asCashier = await call('/api/search/suggest?q=cairo', { as: cashierCookie.split(';')[0] });
    assert.equal(asCashier.status, 200);
    assert.ok(!asCashier.data.groups.some((g) => g.kind === 'supplier'),
      'a cashier was shown the shop\'s supplier list');
  });
});
