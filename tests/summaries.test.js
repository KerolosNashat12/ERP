/**
 * One shelf, one set of numbers - and the counters above the lists.
 *
 * ── The bug this exists to keep fixed ───────────────────────────────────────
 * The owner photographed two screens of his own shop, minutes apart. The home
 * screen said 682 units and EGP 108,005 of stock. The valuation report said 673
 * and EGP 107,195. Same shop, same moment, two answers, and nothing on either
 * screen to say which was right or why they differed.
 *
 * The cause was that each screen had its own copy of the question. The home
 * screen summed the whole stock view; the report and the stock grid each added
 * `variant_active = 1` to their own version of it. Nine pieces sat on a variant
 * somebody had switched off - real stock, real money, invisible on two screens
 * out of three and unexplained on the third.
 *
 * So the rule is now one function, and it is the rule that matches the shelf:
 * stock that EXISTS is counted, whether or not the variant is still being sold.
 * A variant is switched off to stop selling it, not to stop owning it. What
 * used to be silently dropped is now named instead - `stopped_quantity` - so
 * the figure can be explained rather than merely reconciled.
 *
 * The second half of this file is the counters above Products, Stock and
 * Suppliers. The one property that matters there is that they describe the list
 * underneath them: filter the list, and the cards must move with it. A header
 * that keeps describing the whole shop while the table shows one brand is worse
 * than no header, because it is believed.
 */
import './single-shop.js'; // must be first — see that file
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'data', 'summaries-test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
process.env.MM_DB_FILE = path.join(dir, 'shop.db');

const { createApp } = await import('../src/server.js');
const {
  initDb, closeDb, getDb, applySchema,
} = await import('../src/infrastructure/database/connection.js');
const { seedBaseline } = await import('../src/infrastructure/database/seed.js');
const { runMigrations } = await import('../src/infrastructure/database/migrations/index.js');

let base = '';
let server = null;
let cookie = '';

async function call(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
      'Idempotency-Key': `t-${Math.random().toString(36).slice(2)}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

const ok = async (pathname, options) => {
  const res = await call(pathname, options);
  assert.ok(res.status < 400, `${pathname} answered ${res.status}: ${JSON.stringify(res.data)}`);
  return res.data;
};

test('stock figures agree, and the counters describe what is under them', async (t) => {
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

  const db = getDb();
  const warehouse = await db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get();

  /** A product with one variant, some stock at a known cost, and a gender. */
  let next = 5000;
  async function stocked({ gender = 'unisex', quantity = 10, cost = 50, price = 100, active = 1 }) {
    const id = next;
    next += 1;
    await db.prepare(`INSERT INTO products (id, sku_prefix, name_en, name_ar, base_price, gender, is_active, is_published)
                      VALUES (?, ?, ?, ?, ?, ?, 1, 1)`).run(id, `S${id}`, `S${id}`, `S${id}`, price, gender);
    await db.prepare(`INSERT INTO product_variants (id, product_id, sku, variant_label, cost_price, selling_price, is_active)
                      VALUES (?, ?, ?, '', ?, ?, ?)`).run(id, id, `S${id}-A`, cost, price, active);
    await db.prepare(`INSERT INTO stock_levels (variant_id, warehouse_id, quantity, average_cost)
                      VALUES (?, ?, ?, ?)`).run(id, warehouse.id, quantity, cost);
    return id;
  }

  // Three sellable products, and one whose variant has been switched off with
  // stock still on it. That last one is the whole bug.
  await stocked({ gender: 'women', quantity: 10, cost: 50 });
  await stocked({ gender: 'men', quantity: 4, cost: 25 });
  await stocked({ gender: 'unisex', quantity: 6, cost: 10 });
  await stocked({ gender: 'women', quantity: 9, cost: 90, active: 0 });

  await t.test('the home screen, the report and the stock cards say the same thing', async () => {
    const [dashboard, report, cards] = await Promise.all([
      ok('/api/dashboard'),
      ok('/api/reports/inventory_valuation'),
      ok('/api/inventory/summary'),
    ]);

    assert.equal(dashboard.kpis.stockValue, report.summary.total_cost_value,
      'the home screen and the valuation report must value the same shelf identically');
    assert.equal(dashboard.kpis.stockUnits, report.summary.total_quantity);
    assert.equal(cards.stock_value, report.summary.total_cost_value);
    assert.equal(cards.quantity, report.summary.total_quantity);

    // 10×50 + 4×25 + 6×10 + 9×90 = 500 + 100 + 60 + 810
    assert.equal(report.summary.total_cost_value, 1470);
    assert.equal(report.summary.total_quantity, 29);
  });

  await t.test('stock on a switched-off variant is counted AND named', async () => {
    const report = await ok('/api/reports/inventory_valuation');
    assert.equal(report.summary.stopped_quantity, 9,
      'nine pieces sit on a variant nobody sells — they are still the shop\'s');
    assert.equal(report.summary.stopped_value, 810);

    const dashboard = await ok('/api/dashboard');
    assert.equal(dashboard.kpis.stockStoppedUnits, 9,
      'the tile has to be able to explain its own total, not just be reconciled against');

    // And the line is findable, marked as what it is, rather than hidden.
    const stopped = report.rows.filter((row) => row.variant_state === 'stopped_variant');
    assert.equal(stopped.length, 1);
    assert.equal(stopped[0].quantity, 9);
  });

  await t.test('the report can be narrowed to just the stopped stock', async () => {
    const only = await ok('/api/reports/inventory_valuation?stopped=only');
    assert.equal(only.rows.length, 1);
    assert.equal(only.summary.total_quantity, 9);
    assert.equal(only.summary.total_cost_value, 810);
  });

  await t.test('the product counters partition the catalogue', async () => {
    const all = await ok('/api/products/summary');
    assert.equal(all.women + all.men + all.unisex, all.products,
      'every product is counted under exactly one heading — the owner classifies against these');
    assert.ok(all.products >= 4);
    assert.equal(all.stopped, 0, 'the four products themselves are all active');
    /*
     * Zero, and this is the point of the query rather than an incidental
     * assertion: one of these four has nine pieces on a variant somebody
     * switched off. It is not out of stock. Counting only active variants would
     * say it was.
     */
    assert.equal(all.out_of_stock, 0);
  });

  await t.test('the counters follow the filter, and never describe a different list', async () => {
    const [cards, list] = await Promise.all([
      ok('/api/products/summary?gender=women'),
      ok('/api/products?gender=women&pageSize=500'),
    ]);
    assert.equal(cards.products, list.total,
      'the header and the table must be counting the same rows');
    assert.equal(cards.men, 0);
    assert.equal(cards.unisex, 0);
    assert.equal(cards.women, cards.products);
  });

  await t.test('a deleted product leaves the counters, as it leaves the list', async () => {
    const before = await ok('/api/products/summary');
    const doomed = await stocked({ gender: 'men', quantity: 1 });
    const afterAdding = await ok('/api/products/summary');
    assert.equal(afterAdding.products, before.products + 1);

    await ok('/api/trash', { method: 'POST', body: { entityType: 'product', entityId: doomed, reason: 'test' } });
    const afterDeleting = await ok('/api/products/summary');
    assert.equal(afterDeleting.products, before.products,
      'a product in the recycle bin is off the list, so it must be off the counters too');
  });

  await t.test('the supplier counters answer "how much do I owe, and to whom"', async () => {
    const supplier = await ok('/api/suppliers', {
      method: 'POST', body: { name_en: 'Test Supplier', payment_terms_days: 30 },
    });
    const empty = await ok('/api/suppliers/summary');
    assert.equal(empty.suppliers, 1);
    assert.equal(empty.outstanding, 0);
    assert.equal(empty.suppliers_owed, 0);

    const order = await ok('/api/purchases', {
      method: 'POST',
      body: {
        supplier_id: supplier.id,
        order_date: new Date().toISOString().slice(0, 10),
        lines: [{ variant_id: 5000, quantity_ordered: 4, unit_cost: 85, discount_percent: 0, tax_rate: 0 }],
      },
    });
    await ok(`/api/purchases/${order.id}/approve`, { method: 'POST', body: {} });

    const owed = await ok('/api/suppliers/summary');
    assert.equal(owed.orders, 1);
    assert.equal(owed.open_orders, 1);
    assert.equal(owed.outstanding, 340, '4 × 85, unpaid');
    assert.equal(owed.suppliers_owed, 1);
    assert.equal(owed.suppliers_used, 1);
  });
});
