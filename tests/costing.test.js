/**
 * WHAT A SALE COSTS, WHEN THE SAME PRODUCT WAS BOUGHT AT TWO PRICES.
 *
 * The owner's question, in his words: he buys from «حور» at 250 and sells at
 * 300; he then raises another purchase order for the same product at 300. When
 * he sells one — «هامش الربح هيتخصم منين», and which purchase order is drawn
 * down first?
 *
 * The answer this ERP gives is MOVING WEIGHTED AVERAGE. There are no purchase
 * layers to draw down: one piece at 250 and one at 300 make two pieces at 275,
 * and a sale costs 275 whichever order it "came from". That is a decision, not
 * an accident, and it is the right one for a shop that sells identical
 * bottles out of one pile — FIFO would require tracking which physical bottle
 * left, which nobody at a till is going to do.
 *
 * ── The bug this file was written for ──────────────────────────────────────
 * Asking that question exposed a real one. `sale_lines.unit_cost` was filled
 * from the variant's STANDARD cost — which receiving a purchase order
 * overwrites with the latest price — while the sale HEADER got the true
 * average. So on exactly his numbers:
 *
 *     sales_summary      profit 25   (header: 300 − 275)
 *     profit_and_costs   profit 25   (header)
 *     sales_by_product   profit  0   (line:   300 − 300)   ← wrong
 *
 * The report a shop opens to ask what a product earns was the one telling it
 * zero. Same shape as the 682-vs-673 disagreement he found before: two figures
 * for one fact, and the reader has no way to tell which is real.
 */
import './single-shop.js'; // must be first — see that file
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'data', 'costing-test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
process.env.MM_DB_FILE = path.join(dir, 'shop.db');

const { createApp } = await import('../src/server.js');
const { initDb, closeDb, applySchema, getDb } = await import('../src/infrastructure/database/connection.js');
const { seedBaseline } = await import('../src/infrastructure/database/seed.js');
const { runMigrations } = await import('../src/infrastructure/database/migrations/index.js');

let base = '';
let cookie = '';
let supplierId = null;

const call = async (pathname, { method = 'GET', body } = {}) => {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
      'Idempotency-Key': `ct-${Math.random().toString(36).slice(2)}`,
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

const today = () => new Date().toISOString().slice(0, 10);

const makeProduct = async (code, cost, sell) => {
  const p = await ok('/api/products', {
    method: 'POST',
    body: {
      sku_prefix: code, name_en: code, name_ar: code, base_price: sell, is_published: 1,
      variants: [{ sku: `${code}-A`, cost_price: cost, selling_price: sell }],
    },
  });
  return p.variants[0].id;
};

/** Raise a purchase order, approve it, receive it whole. */
const buy = async (variantId, quantity, unitCost) => {
  const po = await ok('/api/purchases', {
    method: 'POST',
    body: {
      supplier_id: supplierId,
      order_date: today(),
      lines: [{ variant_id: variantId, quantity_ordered: quantity, unit_cost: unitCost }],
    },
  });
  await call(`/api/purchases/${po.id}/approve`, { method: 'POST', body: {} });
  const full = await ok(`/api/purchases/${po.id}`);
  await ok(`/api/purchases/${po.id}/receive`, {
    method: 'POST',
    body: { receipts: full.lines.map((l) => ({ line_id: l.id, quantity })) },
  });
  return po;
};

const sell = (variantId, quantity, paid) => ok('/api/sales', {
  method: 'POST',
  body: { lines: [{ key: 1, variant_id: variantId, quantity }], payment_method: 'cash', paid_amount: paid },
});

const level = async (variantId) => getDb()
  .prepare('SELECT quantity, average_cost FROM stock_levels WHERE variant_id = ?')
  .get(variantId);

test('buying the same product at two prices', async (t) => {
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

  supplierId = (await ok('/api/suppliers', {
    method: 'POST', body: { name_en: 'Hoor', name_ar: 'حور' },
  })).id;

  await t.test('two prices become one average — there is no layer to draw down', async () => {
    const v = await makeProduct('CT-AVG', 250, 300);
    await buy(v, 1, 250);
    assert.equal(Number((await level(v)).average_cost), 250);

    await buy(v, 1, 300);
    const after = await level(v);
    assert.equal(Number(after.quantity), 2);
    assert.equal(Number(after.average_cost), 275,
      'the pile of two should be worth 275 each, not 250 or 300');
  });

  await t.test('the sale costs the average, and every report says the same number', async () => {
    /*
     * THE ONE THAT WAS BROKEN. Three reports, one sale. If they disagree, the
     * shop owner has no way to know which is real — and the one he would
     * naturally open, «الأرباح حسب المنتج», was the wrong one.
     */
    const v = await makeProduct('CT-REPORTS', 250, 300);
    await buy(v, 1, 250);
    await buy(v, 1, 300);
    const sale = await sell(v, 1, 300);

    const db = getDb();
    const header = await db.prepare('SELECT total_amount, total_cost FROM sales WHERE id = ?').get(sale.id);
    const line = await db.prepare('SELECT quantity, unit_cost, line_total FROM sale_lines WHERE sale_id = ?').get(sale.id);

    assert.equal(Number(header.total_cost), 275, 'the sale did not cost the average');
    assert.equal(Number(line.unit_cost), 275,
      'the LINE still carries the latest purchase price instead of what was sold');

    const headerProfit = Number(header.total_amount) - Number(header.total_cost);
    const lineProfit = Number(line.line_total) - Number(line.quantity) * Number(line.unit_cost);
    assert.equal(headerProfit, lineProfit,
      `the invoice and its own line disagree: ${headerProfit} vs ${lineProfit}`);
    assert.equal(headerProfit, 25);
  });

  await t.test('a receipt updates the standard cost but NEVER the selling price', async () => {
    /*
     * He asked about "a purchase order with cost 300 and selling 400". A
     * purchase order has no selling price — it records what the SHOP pays. So
     * receiving a dearer batch quietly leaves the shelf price where it was,
     * and a shop that does not look is selling its new stock at the old
     * margin. That is the honest behaviour (an ERP must not reprice a shop's
     * shelves by itself) but it is the thing to watch, so it is pinned here.
     */
    const v = await makeProduct('CT-PRICE', 250, 300);
    await buy(v, 1, 250);
    await buy(v, 1, 300);
    const variant = await getDb()
      .prepare('SELECT cost_price, selling_price FROM product_variants WHERE id = ?').get(v);
    assert.equal(Number(variant.cost_price), 300, 'the standard cost did not follow the last purchase');
    assert.equal(Number(variant.selling_price), 300, 'receiving stock changed the shelf price by itself');
  });

  await t.test('selling more than one batch costs the average for all of them', async () => {
    const v = await makeProduct('CT-MULTI', 100, 500);
    await buy(v, 3, 100);   // 300
    await buy(v, 1, 300);   // 300  -> 4 pieces, 600, avg 150
    assert.equal(Number((await level(v)).average_cost), 150);

    const sale = await sell(v, 2, 1000);
    const header = await getDb().prepare('SELECT total_cost FROM sales WHERE id = ?').get(sale.id);
    assert.equal(Number(header.total_cost), 300, 'two pieces at an average of 150 should cost 300');
    // …and the remaining two are still worth 150 each: issuing stock does not
    // move the average, which is what "weighted average" means.
    assert.equal(Number((await level(v)).average_cost), 150);
  });

  await t.test('a void puts the piece back at what it left at, not at today\'s average', async () => {
    /*
     * The edge that would quietly corrupt a shop's stock value: sell a cheap
     * piece, buy expensive ones, then void the sale. If the piece came back at
     * today's average the shop would have invented value out of a cancelled
     * transaction.
     */
    const v = await makeProduct('CT-VOID', 250, 400);
    await buy(v, 1, 250);
    const sale = await sell(v, 1, 400);
    await buy(v, 2, 400);
    assert.equal(Number((await level(v)).average_cost), 400);

    await ok(`/api/sales/${sale.id}/void`, { method: 'POST', body: { reason: 'test' } });
    const after = await level(v);
    assert.equal(Number(after.quantity), 3);
    // (2 × 400 + 1 × 250) / 3 = 350
    assert.equal(Number(after.average_cost), 350,
      'the voided piece came back at the wrong cost');
  });

  await t.test('a customer return re-enters stock at what it was sold at', async () => {
    const v = await makeProduct('CT-RETURN', 250, 400);
    await buy(v, 1, 250);
    const sale = await sell(v, 1, 400);
    await buy(v, 3, 500);
    assert.equal(Number((await level(v)).average_cost), 500);

    const lookup = await ok(`/api/returns/lookup?reference=${sale.invoice_no}`);
    await ok('/api/returns', {
      method: 'POST',
      body: {
        return_type: 'with_receipt', sale_id: sale.id, reason_code: 'changed_mind',
        refund_method: 'cash',
        lines: [{ sale_line_id: lookup.lines[0].sale_line_id, quantity: 1, condition: 'resellable' }],
      },
    });
    const after = await level(v);
    assert.equal(Number(after.quantity), 4);
    // (3 × 500 + 1 × 250) / 4 = 437.5
    assert.equal(Number(after.average_cost), 437.5,
      'a returned piece re-entered stock at the wrong cost');
  });

  await t.test('stock that arrived without a purchase has no cost, and the report says so', async () => {
    /*
     * Not a bug — a limit, and one the profit report already declares in its
     * own "what this cannot see" callout. Stock typed in as a correction has no
     * price behind it, so selling it reads as 100% margin. Pinned here so that
     * if the callout is ever dropped, something fails.
     */
    const v = await makeProduct('CT-NOCOST', 0, 400);
    await ok('/api/inventory/quick-adjust', {
      method: 'POST', body: { variantId: v, newQuantity: 5, reason: 'correction' },
    });
    assert.equal(Number((await level(v)).average_cost), 0);

    const sale = await sell(v, 1, 400);
    const header = await getDb().prepare('SELECT total_amount, total_cost FROM sales WHERE id = ?').get(sale.id);
    assert.equal(Number(header.total_cost), 0);

    const report = await ok(`/api/reports/profit_and_costs?from=${today()}&to=${today()}`);
    const blob = JSON.stringify(report);
    assert.match(blob, /cannot see|لا يستطيع|بدون تكلفة|no cost|zero cost/i,
      'the profit report no longer warns that some sales have no cost behind them');
  });
});
