/**
 * One search box behaviour, everywhere in the ERP.
 *
 * The owner's sentence was "at the ERP dashboard we need to search using
 * product name or code — both work for the whole system". He works with a
 * scanner in one hand: whatever he types or scans into any box must find the
 * thing. Before this, only POS and the stock grid behaved that way, and he had
 * to remember which screen was which.
 *
 * So this suite is not about a function — it is about every search box in the
 * product, over real HTTP, against one deliberately awkward catalogue:
 *
 *   - a product whose name exists only in Arabic (an English word must not
 *     find it, and an Arabic word must, `%` wrapping and all);
 *   - a variant whose SKU has nothing to do with its product's code, which is
 *     what breaks any implementation that searches only `products`;
 *   - a barcode that is a strict substring of another product's barcode, so
 *     "the exact code sorts first" is a claim with something to beat;
 *   - two products sharing a word, so a name search has to return both.
 *
 * Every screen is then asked the same six questions: name, product code,
 * variant SKU, barcode, is the exact code first, and does a term that matches
 * nothing return nothing rather than everything.
 *
 * The last block loads a 5,000-product catalogue and 2,000 invoices and times
 * the same searches, because "feels instant on a shop PC" is a measurement.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'data', 'unified-search-test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

process.env.MM_PLATFORM = '0';
process.env.MM_DB_FILE = path.join(dir, 'shop.db');

const { createApp } = await import('../src/server.js');
const {
  initDb, applySchema, closeDb, getDb, transaction,
} = await import('../src/infrastructure/database/connection.js');
const { runMigrations } = await import('../src/infrastructure/database/migrations/index.js');
const { seedBaseline } = await import('../src/infrastructure/database/seed.js');

let base = '';
let server = null;
let cookie = '';

async function api(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const error = new Error(data?.error?.message || `HTTP ${res.status} on ${pathname}`);
    error.status = res.status;
    error.payload = data;
    throw error;
  }
  return data;
}

// --------------------------------------------------------------- the fixture

/**
 * Codes chosen so the awkward cases are unmissable:
 *   CHAIN.barcode ('4820117') is a strict substring of ANKLET.barcode
 *   ('84820117119'), and CHAIN's variant SKU ('XZ-9001') shares nothing with
 *   its product code ('CHN').
 */
const CATALOGUE = {
  arabic: {
    sku_prefix: 'TAQM',
    // The schema requires a name; a shop that sells only to Arabic speakers
    // types the Arabic one into both fields. There is no Latin word anywhere
    // on this product, which is the point.
    name_en: 'طقم إكسسوارات',
    name_ar: 'طقم إكسسوارات ذهبي',
    sku: 'TAQM-01',
    barcode: '7010009',
  },
  chain: {
    sku_prefix: 'CHN',
    name_en: 'Gold Chain',
    name_ar: 'سلسلة ذهبية',
    sku: 'XZ-9001',
    barcode: '4820117',
  },
  anklet: {
    sku_prefix: 'ANK',
    name_en: 'Gold Anklet',
    name_ar: 'خلخال ذهبي',
    sku: 'ANK-01',
    barcode: '84820117119',
  },
};

/** Everything the assertions need to name a row later. */
const shop = { products: {}, variants: {}, docs: {} };

async function createProduct(spec, { supplierId }) {
  const saved = await api('/api/products', {
    method: 'POST',
    body: {
      sku_prefix: spec.sku_prefix,
      name_en: spec.name_en,
      name_ar: spec.name_ar,
      supplier_id: supplierId,
      unit: 'piece',
      tax_rate: 0,
      base_cost: 10,
      base_price: 25,
      track_inventory: true,
      is_active: true,
      is_published: true,
      attribute_ids: [],
      variants: [{
        sku: spec.sku,
        barcode: spec.barcode,
        variant_label: null,
        cost_price: 10,
        selling_price: 25,
        wholesale_price: 20,
        reorder_level: 2,
        reorder_quantity: 10,
        is_active: true,
        options: [],
      }],
    },
  });
  const full = await api(`/api/products/${saved.id}`);
  return { product: full, variant: full.variants[0] };
}

/** A purchase order, approved and fully received — which also writes the ledger. */
async function receivePurchase(supplierId, variantIds) {
  const order = await api('/api/purchases', {
    method: 'POST',
    body: {
      supplier_id: supplierId,
      order_date: new Date().toISOString().slice(0, 10),
      discount_amount: 0,
      shipping_amount: 0,
      status: 'draft',
      lines: variantIds.map((variant_id) => ({
        variant_id, quantity_ordered: 40, unit_cost: 10, discount_percent: 0, tax_rate: 0,
      })),
    },
  });
  await api(`/api/purchases/${order.id}/approve`, { method: 'POST' });
  const full = await api(`/api/purchases/${order.id}`);
  await api(`/api/purchases/${order.id}/receive`, {
    method: 'POST',
    body: { receipts: full.lines.map((l) => ({ line_id: l.id, quantity: l.quantity_ordered })) },
  });
  return api(`/api/purchases/${order.id}`);
}

async function sell(variantIds) {
  const sale = await api('/api/sales', {
    method: 'POST',
    body: {
      payment_method: 'cash',
      paid_amount: 1000,
      manual_discount: 0,
      lines: variantIds.map((variant_id) => ({
        variant_id, quantity: 2, discount_percent: 0, discount_amount: 0,
      })),
    },
  });
  return api(`/api/sales/${sale.id}`);
}

async function refund(sale, variantId) {
  const line = sale.lines.find((l) => l.variant_id === variantId);
  const created = await api('/api/returns', {
    method: 'POST',
    body: {
      return_type: 'with_receipt',
      sale_id: sale.id,
      reason_code: 'defective',
      refund_method: 'cash',
      restocking_fee: 0,
      lines: [{
        sale_line_id: line.id, variant_id: variantId, quantity: 1, condition: 'resellable',
      }],
    },
  });
  return created;
}

async function count(variantIds) {
  const created = await api('/api/inventory/adjustments', {
    method: 'POST',
    body: {
      reason: 'stock_take',
      notes: 'shelf count',
      lines: variantIds.map((variant_id) => ({
        variant_id, system_qty: 10, counted_qty: 10, unit_cost: 10,
      })),
    },
  });
  return created;
}

async function orderOnline(variantIds, name) {
  const saved = cookie;
  cookie = ''; // the storefront is not signed in
  let placed;
  try {
    placed = await api('/api/shop/orders', {
      method: 'POST',
      body: {
        lines: variantIds.map((variant_id) => ({ variant_id, quantity: 1 })),
        customer: { name, phone: '01000000001' },
        address: { line: '1 Test Street', city: 'Cairo' },
        language: 'en',
      },
    });
  } finally {
    cookie = saved;
  }
  // Checkout answers the customer, not the shop: it returns the order number
  // and no internal id. The staff list is where the id lives.
  const { rows } = await api('/api/web-orders');
  const row = rows.find((r) => r.order_no === placed.order_no);
  return { ...placed, id: row.id };
}

before(async () => {
  await initDb();
  await applySchema();
  await runMigrations();
  await seedBaseline();

  const app = createApp();
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  await api('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  await api('/api/settings', { method: 'PUT', body: { 'shop.enabled': '1' } });

  const supplier = await api('/api/suppliers', {
    method: 'POST',
    body: { code: 'SUP-TEST', name_en: 'Test Supplier', name_ar: 'مورد', is_active: true },
  });

  // Order matters. Everything below is created oldest-first so that the
  // "newest wins" default ordering of each screen puts the WRONG row on top —
  // the exact-code assertions have something real to overturn.
  for (const key of ['arabic', 'chain', 'anklet']) {
    const made = await createProduct(CATALOGUE[key], { supplierId: supplier.id });
    shop.products[key] = made.product;
    shop.variants[key] = made.variant;
  }

  const v = (k) => shop.variants[k].id;

  shop.docs.purchaseChain = await receivePurchase(supplier.id, [v('chain'), v('arabic')]);
  shop.docs.purchaseAnklet = await receivePurchase(supplier.id, [v('anklet')]);

  shop.docs.saleChain = await sell([v('chain'), v('arabic')]);
  shop.docs.saleAnklet = await sell([v('anklet')]);

  shop.docs.returnChain = await refund(shop.docs.saleChain, v('chain'));
  shop.docs.returnAnklet = await refund(shop.docs.saleAnklet, v('anklet'));

  shop.docs.countChain = await count([v('chain'), v('arabic')]);
  shop.docs.countAnklet = await count([v('anklet')]);

  shop.docs.webChain = await orderOnline([v('chain'), v('arabic')], 'Web Chain Buyer');
  shop.docs.webAnklet = await orderOnline([v('anklet')], 'Web Anklet Buyer');
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await closeDb();
});

// ------------------------------------------------------------- the contract

/**
 * Every search box in the ERP, described the same way: where to send the term,
 * how to pull the rows out, and how to tell whether a given row is "the chain"
 * or "the anklet". `documentNumber` is the row's own identity, used to check
 * that searching a document number still works exactly as it did.
 */
const SCREENS = [
  {
    name: 'Products',
    url: (term) => `/api/products?search=${encodeURIComponent(term)}`,
    chain: () => shop.products.chain.id,
    anklet: () => shop.products.anklet.id,
    arabic: () => shop.products.arabic.id,
    idOf: (row) => row.id,
  },
  {
    name: 'Product lookup (POS, pickers, labels)',
    url: (term) => `/api/products/lookup?q=${encodeURIComponent(term)}`,
    chain: () => shop.variants.chain.id,
    anklet: () => shop.variants.anklet.id,
    arabic: () => shop.variants.arabic.id,
    idOf: (row) => row.variant_id,
  },
  {
    name: 'Stock on hand',
    url: (term) => `/api/inventory/stock?search=${encodeURIComponent(term)}`,
    chain: () => shop.variants.chain.id,
    anklet: () => shop.variants.anklet.id,
    arabic: () => shop.variants.arabic.id,
    idOf: (row) => row.variant_id,
  },
  {
    name: 'Stock movements',
    url: (term) => `/api/inventory/movements?search=${encodeURIComponent(term)}`,
    chain: () => shop.variants.chain.id,
    anklet: () => shop.variants.anklet.id,
    arabic: () => shop.variants.arabic.id,
    idOf: (row) => row.variant_id,
  },
  {
    name: 'Stock counts',
    url: (term) => `/api/inventory/adjustments?search=${encodeURIComponent(term)}`,
    chain: () => shop.docs.countChain.id,
    anklet: () => shop.docs.countAnklet.id,
    arabic: () => shop.docs.countChain.id,
    idOf: (row) => row.id,
    documentNumber: () => shop.docs.countAnklet.adjustment_no,
    documentId: () => shop.docs.countAnklet.id,
  },
  {
    name: 'Purchase orders',
    url: (term) => `/api/purchases?search=${encodeURIComponent(term)}`,
    chain: () => shop.docs.purchaseChain.id,
    anklet: () => shop.docs.purchaseAnklet.id,
    arabic: () => shop.docs.purchaseChain.id,
    idOf: (row) => row.id,
    documentNumber: () => shop.docs.purchaseAnklet.po_number,
    documentId: () => shop.docs.purchaseAnklet.id,
  },
  {
    name: 'Sales',
    url: (term) => `/api/sales?search=${encodeURIComponent(term)}`,
    chain: () => shop.docs.saleChain.id,
    anklet: () => shop.docs.saleAnklet.id,
    arabic: () => shop.docs.saleChain.id,
    idOf: (row) => row.id,
    documentNumber: () => shop.docs.saleAnklet.invoice_no,
    documentId: () => shop.docs.saleAnklet.id,
  },
  {
    name: 'Returns',
    url: (term) => `/api/returns?search=${encodeURIComponent(term)}`,
    chain: () => shop.docs.returnChain.id,
    anklet: () => shop.docs.returnAnklet.id,
    arabic: null, // return #1 gave back the chain only — see refund() above
    idOf: (row) => row.id,
    documentNumber: () => shop.docs.returnAnklet.return_no,
    documentId: () => shop.docs.returnAnklet.id,
  },
  {
    name: 'Web orders',
    url: (term) => `/api/web-orders?search=${encodeURIComponent(term)}`,
    chain: () => shop.docs.webChain.id,
    anklet: () => shop.docs.webAnklet.id,
    arabic: () => shop.docs.webChain.id,
    idOf: (row) => row.id,
    documentNumber: () => shop.docs.webAnklet.order_no,
    documentId: () => shop.docs.webAnklet.id,
  },
];

const rowsOf = (payload) => payload.rows || [];
const idsOf = (screen, payload) => rowsOf(payload).map(screen.idOf);

for (const screen of SCREENS) {
  test(`${screen.name}: the product's name finds it`, async () => {
    const ids = idsOf(screen, await api(screen.url('Gold Chain')));
    assert.ok(ids.includes(screen.chain()), `"Gold Chain" did not find it on ${screen.name}`);
  });

  test(`${screen.name}: a word shared by two products finds both`, async () => {
    const ids = idsOf(screen, await api(screen.url('Gold')));
    assert.ok(ids.includes(screen.chain()), `"Gold" missed the chain on ${screen.name}`);
    assert.ok(ids.includes(screen.anklet()), `"Gold" missed the anklet on ${screen.name}`);
  });

  test(`${screen.name}: the product code finds it`, async () => {
    const ids = idsOf(screen, await api(screen.url(CATALOGUE.chain.sku_prefix)));
    assert.ok(ids.includes(screen.chain()), `"CHN" did not find it on ${screen.name}`);
  });

  test(`${screen.name}: the variant SKU finds it`, async () => {
    // 'XZ-9001' has nothing in common with the product's own code, so nothing
    // but a real variant-level match can answer this.
    const ids = idsOf(screen, await api(screen.url(CATALOGUE.chain.sku)));
    assert.ok(ids.includes(screen.chain()), `"XZ-9001" did not find it on ${screen.name}`);
  });

  test(`${screen.name}: the barcode finds it`, async () => {
    const ids = idsOf(screen, await api(screen.url(CATALOGUE.chain.barcode)));
    assert.ok(ids.includes(screen.chain()), `the barcode did not find it on ${screen.name}`);
  });

  test(`${screen.name}: an exact code is the first row`, async () => {
    // '4820117' is the chain's whole barcode and also sits inside the anklet's
    // '84820117119'. Both come back; the exact one has to lead, and the anklet
    // is the row every one of these screens would otherwise put first.
    const payload = await api(screen.url(CATALOGUE.chain.barcode));
    const ids = idsOf(screen, payload);
    assert.ok(ids.includes(screen.anklet()), 'the substring match should still be in the results');
    assert.equal(ids[0], screen.chain(), `${screen.name} put the exact barcode second`);

    const bySku = idsOf(screen, await api(screen.url(CATALOGUE.chain.sku)));
    assert.equal(bySku[0], screen.chain(), `${screen.name} did not lead with the exact SKU`);
  });

  test(`${screen.name}: a term that matches nothing returns nothing`, async () => {
    const payload = await api(screen.url('zzqqxx-no-such-thing'));
    assert.equal(rowsOf(payload).length, 0, `${screen.name} returned rows for a nonsense term`);
    if (payload.total !== undefined) assert.equal(payload.total, 0);
  });

  test(`${screen.name}: an Arabic name is found by an Arabic term`, async () => {
    if (!screen.arabic) return;
    const ids = idsOf(screen, await api(screen.url('إكسسوارات')));
    assert.ok(ids.includes(screen.arabic()), `an Arabic term missed on ${screen.name}`);
    // …and the Arabic-only product is not reachable by an English word.
    const latin = idsOf(screen, await api(screen.url('Chain')));
    if (screen.name === 'Products' || screen.name.startsWith('Product lookup')) {
      assert.ok(!latin.includes(screen.arabic()), 'an English word reached an Arabic-only product');
    }
  });

  if (screen.documentNumber) {
    test(`${screen.name}: the document number still works, and says so`, async () => {
      const number = screen.documentNumber();
      const payload = await api(screen.url(number));
      const rows = rowsOf(payload);
      assert.ok(rows.length >= 1, `${screen.name} lost its document-number search`);
      assert.equal(screen.idOf(rows[0]), screen.documentId());
      assert.equal(rows[0].search_match, 'document');
    });

    test(`${screen.name}: a line match says it was a line, and which product`, async () => {
      const rows = rowsOf(await api(screen.url(CATALOGUE.chain.sku)));
      const row = rows.find((r) => screen.idOf(r) === screen.chain());
      assert.ok(row, 'the document containing that SKU should be in the results');
      assert.equal(row.search_match, 'line');
      assert.equal(row.search_match_sku, CATALOGUE.chain.sku);
      assert.equal(row.search_match_name_en, CATALOGUE.chain.name_en);
      assert.equal(row.search_match_name_ar, CATALOGUE.chain.name_ar);
    });
  }
}

// -------------------------------------------------- rules that span screens

test('the same term finds the same product on every screen', async () => {
  // The whole point of the feature, stated once: one term, every box.
  for (const term of [CATALOGUE.chain.name_en, CATALOGUE.chain.sku_prefix,
    CATALOGUE.chain.sku, CATALOGUE.chain.barcode]) {
    for (const screen of SCREENS) {
      const ids = idsOf(screen, await api(screen.url(term)));
      assert.ok(ids.includes(screen.chain()), `"${term}" failed on ${screen.name}`);
    }
  }
});

test('the scanner endpoint is untouched and still resolves a code exactly', async () => {
  const byBarcode = await api(`/api/products/scan/${CATALOGUE.chain.barcode}`);
  assert.equal(byBarcode.variant_id, shop.variants.chain.id);
  const bySku = await api(`/api/products/scan/${encodeURIComponent(CATALOGUE.chain.sku)}`);
  assert.equal(bySku.variant_id, shop.variants.chain.id);
  // The anklet's barcode *contains* the chain's; an exact endpoint must not
  // be fooled by that in either direction.
  const anklet = await api(`/api/products/scan/${CATALOGUE.anklet.barcode}`);
  assert.equal(anklet.variant_id, shop.variants.anklet.id);
});

test("LIKE's own wildcards are not a user's wildcards", async () => {
  /*
   * A typed '%' is a character in a code, not "match everything". Before the
   * shared predicate escaped it, this returned the entire catalogue.
   */
  const payload = await api('/api/products?search=%25');
  assert.equal(payload.total, 0, 'a typed % matched something');
  const many = await api('/api/products?search=%25%25%25');
  assert.equal(many.total, 0, 'a run of wildcards matched something');

  /*
   * `CH_` USED to return nothing, and this test asserted that. It now returns
   * exactly what `CH` returns, and that is a deliberate change rather than a
   * regression — so it is worth saying why, because the line above looks like
   * the safety property and is not.
   *
   * The dangerous behaviour is a typed character matching things that do not
   * contain it: `_` meaning "any character", `%` meaning "everything". That is
   * still prevented — both assertions above, and `escaped()` in the search
   * service, and the ESCAPE clause on every LIKE.
   *
   * What changed is that search now compares NORMALISED text: separators are
   * removed from a token so that `LX-08`, `LX 08` and `lx08` are one code and a
   * person reading it off a label does not have to reproduce its punctuation.
   * `_` is a separator like `-`, so `CH_` reduces to `ch`. That is narrower
   * than a wildcard (it cannot match a row without `ch` in it) and it is what
   * makes typing a code with the wrong dash work at all.
   *
   * The property that still has to hold, and is asserted here: a term with
   * punctuation in it matches NO MORE than the same term without it.
   */
  const withPunctuation = await api('/api/products?search=CH_');
  const without = await api('/api/products?search=CH');
  assert.equal(withPunctuation.total, without.total,
    '"CH_" and "CH" should be the same search');
  assert.ok(withPunctuation.total < Object.keys(CATALOGUE).length,
    'a term with an underscore in it pulled back the whole catalogue');
});

test('a one-character term still searches document numbers and nothing wilder', async () => {
  // Deliberate: expanding a single character into a catalogue-wide line scan
  // would return every invoice in the shop and pay a full scan to do it.
  const payload = await api('/api/sales?search=X');
  assert.equal(rowsOf(payload).length, 0);
});

test('an inactive variant stays out of the pickers but not out of the ledger', async () => {
  // The lookup has always filtered on active; the shared predicate must not
  // have quietly widened it.
  const rows = rowsOf(await api('/api/products/lookup?q=Gold'));
  assert.ok(rows.every((r) => r.variant_active === 1 && r.product_active === 1));
});

// ------------------------------------------------------------------ speed

/**
 * A shop PC with a real catalogue.
 *
 * These are `LIKE '%term%'` searches: no index can serve them, so the honest
 * question is not "is it indexed" but "how long does the scan take, on this
 * many rows, through the whole HTTP stack". 5,000 products and 2,000 invoices
 * is a large shop of this kind — M&M's own catalogue is smaller.
 *
 * The bulk load goes straight to SQL rather than through the API: it is scenery
 * for the measurement, not a test of the write path, and 5,000 round trips
 * would dominate the suite's runtime.
 */
const BULK_PRODUCTS = 5000;
const BULK_SALES = 2000;

/** Generous on purpose — this asserts "no accidental quadratic", not a stopwatch. */
const BUDGET_MS = 750;

const timings = [];

async function timed(label, url, runs = 5) {
  await api(url); // warm the statement cache and the page cache
  const samples = [];
  for (let i = 0; i < runs; i += 1) {
    const started = process.hrtime.bigint();
    await api(url);
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  timings.push({ label, median, worst: samples[samples.length - 1] });
  return median;
}

test('loads a 5,000-product catalogue and 2,000 invoices', async () => {
  const db = getDb();
  const warehouse = await db.prepare('SELECT id FROM warehouses LIMIT 1').get();
  const started = Date.now();

  await transaction(async () => {
    const insertProduct = db.prepare(`
      INSERT INTO products (sku_prefix, name_en, name_ar, unit, tax_rate, base_cost, base_price,
                            track_inventory, is_active)
      VALUES (?, ?, ?, 'piece', 0, 5, 12, 1, 1)
    `);
    const insertVariant = db.prepare(`
      INSERT INTO product_variants (product_id, sku, barcode, variant_label, cost_price, selling_price)
      VALUES (?, ?, ?, ?, 5, 12)
    `);
    const insertLevel = db.prepare(`
      INSERT INTO stock_levels (variant_id, warehouse_id, quantity, reserved_quantity, average_cost)
      VALUES (?, ?, 25, 0, 5)
    `);
    for (let i = 0; i < BULK_PRODUCTS; i += 1) {
      const n = String(i).padStart(5, '0');
      const info = await insertProduct.run(
        `BULK${n}`, `Filler Item ${n}`, `صنف ${n}`,
      );
      const productId = info.lastInsertRowid;
      await insertVariant.run(productId, `BULK${n}-A`, `99${n}0000`, 'Default');
      const variant = await db.prepare('SELECT id FROM product_variants WHERE product_id = ?').get(productId);
      await insertLevel.run(variant.id, warehouse.id);
    }
  });

  await transaction(async () => {
    // Filler invoices are built only from filler variants: if they could carry
    // the fixture's chain, "the exact code is first" would be a coin toss
    // between a thousand equally-exact rows rather than a property of the sort.
    const variants = await db.prepare(
      "SELECT id, sku FROM product_variants WHERE sku LIKE 'BULK%' ORDER BY id LIMIT ?",
    ).all(BULK_SALES);
    const insertSale = db.prepare(`
      INSERT INTO sales (invoice_no, warehouse_id, status, payment_status, sale_date, subtotal,
                         total_amount, total_cost, paid_amount, payment_method)
      VALUES (?, ?, 'completed', 'paid', datetime('now'), 24, 24, 10, 24, 'cash')
    `);
    const insertLine = db.prepare(`
      INSERT INTO sale_lines (sale_id, variant_id, sku, description, quantity, unit_price,
                              unit_cost, line_total)
      VALUES (?, ?, ?, ?, 2, 12, 5, 24)
    `);
    for (let i = 0; i < BULK_SALES; i += 1) {
      const info = await insertSale.run(`BULK-INV-${String(i).padStart(5, '0')}`, warehouse.id);
      const saleId = info.lastInsertRowid;
      const a = variants[i % variants.length];
      const b = variants[(i * 7 + 3) % variants.length];
      await insertLine.run(saleId, a.id, a.sku, 'filler');
      await insertLine.run(saleId, b.id, b.sku, 'filler');
    }
  });

  const products = (await db.prepare('SELECT COUNT(*) AS n FROM products').get()).n;
  const lines = (await db.prepare('SELECT COUNT(*) AS n FROM sale_lines').get()).n;
  console.log(`      catalogue loaded: ${products} products, ${lines} sale lines `
    + `in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  assert.ok(products >= BULK_PRODUCTS);
});

test('every search box still answers quickly on that catalogue', async () => {
  const cases = [
    ['Products — name', '/api/products?search=Filler'],
    ['Products — exact barcode', `/api/products?search=${CATALOGUE.chain.barcode}`],
    ['Products — Arabic', `/api/products?search=${encodeURIComponent('صنف')}`],
    ['Lookup (POS)', '/api/products/lookup?q=Filler'],
    ['Lookup (POS) — exact SKU', `/api/products/lookup?q=${encodeURIComponent(CATALOGUE.chain.sku)}`],
    ['Stock on hand', '/api/inventory/stock?search=Filler'],
    ['Stock movements', '/api/inventory/movements?search=Gold'],
    ['Stock counts', '/api/inventory/adjustments?search=Gold'],
    ['Purchase orders', '/api/purchases?search=Gold'],
    ['Sales — product name', '/api/sales?search=Filler'],
    ['Sales — exact barcode', `/api/sales?search=${CATALOGUE.chain.barcode}`],
    ['Sales — invoice number', '/api/sales?search=BULK-INV-01000'],
    ['Returns', '/api/returns?search=Gold'],
    ['Web orders', '/api/web-orders?search=Gold'],
  ];

  for (const [label, url] of cases) {
    const median = await timed(label, url);
    assert.ok(median < BUDGET_MS, `${label} took ${median.toFixed(1)}ms (budget ${BUDGET_MS}ms)`);
  }

  console.log('\n      search timings on '
    + `${BULK_PRODUCTS} products / ${BULK_SALES} invoices (median of 5, over HTTP):`);
  for (const { label, median, worst } of timings) {
    console.log(`        ${label.padEnd(30)} ${median.toFixed(1).padStart(7)} ms  `
      + `(worst ${worst.toFixed(1)} ms)`);
  }
});

test('the results are still correct at that size', async () => {
  // Speed is worthless if the scan started skipping rows: the same six
  // questions, asked once more with 5,000 products in the way.
  const byBarcode = await api(`/api/products?search=${CATALOGUE.chain.barcode}`);
  assert.equal(byBarcode.rows[0].id, shop.products.chain.id);

  const bySku = await api(`/api/products?search=${encodeURIComponent(CATALOGUE.chain.sku)}`);
  assert.equal(bySku.rows[0].id, shop.products.chain.id);

  const sales = await api(`/api/sales?search=${CATALOGUE.chain.barcode}`);
  assert.equal(sales.rows[0].id, shop.docs.saleChain.id);
  assert.equal(sales.rows[0].search_match, 'line');

  const nothing = await api('/api/products?search=zzqqxx-no-such-thing');
  assert.equal(nothing.total, 0);
});
