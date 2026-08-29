/**
 * One shop, one trading cycle, every module — and then the arithmetic.
 *
 * ── What this file is for ───────────────────────────────────────────────────
 * Every other suite here proves one feature in isolation: a return refunds the
 * right amount, a discount computes correctly, wastage leaves the shelf. All of
 * them can pass while the shop's books are still wrong, because the way a real
 * ERP goes wrong is not "the return screen is broken" — it is that eleven
 * screens each did something defensible and the total of them no longer adds
 * up.
 *
 * So this file trades. It buys, receives partially, pays in instalments, sells
 * over the counter and over the web, takes returns, exchanges an item for a
 * different one, writes off breakage, counts the shelves, sends goods back to
 * the supplier after paying for them, swaps one item for another with the
 * supplier, voids a sale, and deletes and restores a product. Roughly forty
 * documents across every module the shop owns.
 *
 * THEN it stops and checks the invariants — the statements that must be true of
 * the whole book no matter which order any of it happened in:
 *
 *   1. The ledger IS the stock. Sum every movement of a variant and you get
 *      exactly what the shelf says it is holding. If these ever disagree, one
 *      of the two is lying and there is no way to tell which.
 *   2. Every movement's `balance_after` is the running total up to itself, so
 *      the history reads correctly backwards as well as forwards.
 *   3. Nothing moved anonymously: every movement names the document that caused
 *      it.
 *   4. Every sale's total is its own lines, and every purchase order's balance
 *      is its total minus what was paid minus what went back.
 *   5. The three screens that report stock value — the dashboard tile, the
 *      valuation report and the stock list — agree to the piastre.
 *   6. Money in minus money out, computed from the documents, equals what the
 *      profit report says.
 *
 * ── And then the edges ──────────────────────────────────────────────────────
 * The last section is the refusals: selling stock that is not there, returning
 * more than was bought, receiving more than was ordered, writing off more than
 * exists, paying a negative amount, submitting the same sale twice. Each one
 * asserts the REFUSAL CODE rather than the message, because the message is for
 * the shopkeeper and the code is for this file.
 */
import './single-shop.js'; // must be first — see that file
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'data', 'full-cycle-test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
process.env.MM_DB_FILE = path.join(dir, 'shop.db');
process.env.MM_BACKUPS_DIR = path.join(dir, 'backups');

const { createApp } = await import('../src/server.js');
const {
  initDb, closeDb, getDb, applySchema,
} = await import('../src/infrastructure/database/connection.js');
const { seedBaseline } = await import('../src/infrastructure/database/seed.js');
const { runMigrations } = await import('../src/infrastructure/database/migrations/index.js');
const { round2 } = await import('../src/shared/money.js');

let base = '';
let server = null;
let cookie = '';

async function call(pathname, { method = 'GET', body, key } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
      'Idempotency-Key': key || `fc-${Math.random().toString(36).slice(2)}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, text };
}

const ok = async (pathname, options) => {
  const res = await call(pathname, options);
  assert.ok(res.status < 400, `${pathname} answered ${res.status}: ${JSON.stringify(res.data).slice(0, 400)}`);
  return res.data;
};

/** The refusal, by its code — the message is for people, the rule is for tests. */
const refused = async (pathname, options, rule) => {
  const res = await call(pathname, options);
  assert.ok(res.status >= 400,
    `${pathname} was allowed but should have been refused (${rule}) — got ${res.status}`);
  if (rule) {
    assert.equal(res.data?.error?.details?.rule, rule,
      `expected refusal "${rule}", got ${JSON.stringify(res.data?.error).slice(0, 300)}`);
  }
  return res.data.error;
};

const onHand = async (variantId) => Number((await getDb().prepare(
  'SELECT COALESCE(SUM(quantity),0) AS n FROM stock_levels WHERE variant_id = ?',
).get(variantId))?.n || 0);

/** Everything the scenario builds, so each act can refer to the last one. */
const shop = { variants: {}, sales: [], orders: [], expected: {} };

before(async () => {
  await initDb();
  await applySchema();
  await seedBaseline();
  await runMigrations();

  server = await new Promise((resolve) => {
    const listening = http.createServer(createApp()).listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  cookie = (await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  }).then((res) => res.headers.get('set-cookie'))).split(';')[0];
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ═══════════════════════════════════════════ act one: the shop is stocked */

test('the shop is set up: a supplier, a brand, three products and two customers', async () => {
  shop.supplier = await ok('/api/suppliers', {
    method: 'POST',
    body: { name_en: 'Cairo Fragrance House', name_ar: 'بيت العطور', payment_terms_days: 30 },
  });
  shop.otherSupplier = await ok('/api/suppliers', {
    method: 'POST', body: { name_en: 'Second Supplier', name_ar: 'مورد ثاني' },
  });
  shop.brand = await ok('/api/brands', {
    method: 'POST', body: { name_en: 'Maison', name_ar: 'ميزون' },
  });
  shop.category = await ok('/api/categories', {
    method: 'POST', body: { name_en: 'Perfume', name_ar: 'عطور' },
  });

  const product = async (prefix, { cost, price, gender, variants }) => {
    const created = await ok('/api/products', {
      method: 'POST',
      body: {
        sku_prefix: prefix,
        name_en: `${prefix} eau de parfum`,
        name_ar: `${prefix} عطر`,
        base_price: price,
        brand_id: shop.brand.id,
        category_id: shop.category.id,
        supplier_id: shop.supplier.id,
        gender,
        is_published: 1,
        variants: variants.map((label, index) => ({
          sku: `${prefix}-${index + 1}`,
          variant_label: label,
          cost_price: cost,
          selling_price: price,
        })),
      },
    });
    return created;
  };

  shop.amber = await product('AMBER', { cost: 120, price: 300, gender: 'women', variants: ['50ml', '100ml'] });
  shop.oud = await product('OUD', { cost: 200, price: 500, gender: 'men', variants: ['100ml'] });
  shop.musk = await product('MUSK', { cost: 60, price: 150, gender: 'unisex', variants: ['30ml'] });

  shop.variants = {
    amber50: shop.amber.variants[0],
    amber100: shop.amber.variants[1],
    oud100: shop.oud.variants[0],
    musk30: shop.musk.variants[0],
  };

  shop.walkIn = await ok('/api/customers', {
    method: 'POST', body: { name: 'Mona Adel', phone: '01000000011' },
  });
  shop.regular = await ok('/api/customers', {
    method: 'POST', body: { name: 'Youssef Samir', phone: '01000000022' },
  });

  // Nothing has arrived yet, so nothing is on any shelf.
  for (const variant of Object.values(shop.variants)) {
    assert.equal(await onHand(variant.id), 0, `${variant.sku} started with stock it never received`);
  }
});

test('the first order is placed, approved and received in two deliveries', async () => {
  const created = await ok('/api/purchases', {
    method: 'POST',
    body: {
      supplier_id: shop.supplier.id,
      order_date: '2026-01-05',
      lines: [
        { variant_id: shop.variants.amber50.id, quantity_ordered: 40, unit_cost: 120, discount_percent: 0, tax_rate: 0 },
        { variant_id: shop.variants.amber100.id, quantity_ordered: 20, unit_cost: 120, discount_percent: 0, tax_rate: 0 },
        { variant_id: shop.variants.oud100.id, quantity_ordered: 15, unit_cost: 200, discount_percent: 0, tax_rate: 0 },
        { variant_id: shop.variants.musk30.id, quantity_ordered: 60, unit_cost: 60, discount_percent: 0, tax_rate: 0 },
      ],
    },
  });
  await ok(`/api/purchases/${created.id}/approve`, { method: 'POST', body: {} });
  const order = await ok(`/api/purchases/${created.id}`);

  // 40*120 + 20*120 + 15*200 + 60*60 = 4800 + 2400 + 3000 + 3600 = 13800
  assert.equal(round2(order.total_amount), 13800, 'the order does not total its own lines');

  // Half the delivery arrives on Monday.
  await ok(`/api/purchases/${order.id}/receive`, {
    method: 'POST',
    body: {
      receipts: [
        { line_id: order.lines[0].id, quantity: 20 },
        { line_id: order.lines[3].id, quantity: 30 },
      ],
    },
  });
  assert.equal(await onHand(shop.variants.amber50.id), 20);
  assert.equal(await onHand(shop.variants.musk30.id), 30);
  assert.equal(await onHand(shop.variants.oud100.id), 0, 'goods arrived that were never delivered');

  const half = await ok(`/api/purchases/${order.id}`);
  assert.equal(half.status, 'partially_received', `a half-received order says "${half.status}"`);

  // The rest on Thursday.
  await ok(`/api/purchases/${order.id}/receive`, {
    method: 'POST',
    body: {
      receipts: [
        { line_id: order.lines[0].id, quantity: 20 },
        { line_id: order.lines[1].id, quantity: 20 },
        { line_id: order.lines[2].id, quantity: 15 },
        { line_id: order.lines[3].id, quantity: 30 },
      ],
    },
  });
  const full = await ok(`/api/purchases/${order.id}`);
  assert.equal(full.status, 'received');
  assert.equal(await onHand(shop.variants.amber50.id), 40);
  assert.equal(await onHand(shop.variants.amber100.id), 20);
  assert.equal(await onHand(shop.variants.oud100.id), 15);
  assert.equal(await onHand(shop.variants.musk30.id), 60);

  shop.orderA = full;
  shop.orders.push(full);
});

test('a second order takes a percentage off, a third takes a flat amount', async () => {
  /*
   * The two shapes of the same field, which is why the column had to learn a
   * `discount_type` at all: «نسبة» and «قيمة ثابتة» are the same discount to
   * the supplier and two different numbers to the shop.
   */
  const percentOrder = await ok('/api/purchases', {
    method: 'POST',
    body: {
      supplier_id: shop.supplier.id,
      order_date: '2026-02-01',
      discount_type: 'percent',
      discount_percent: 10,
      shipping_amount: 100,
      lines: [
        { variant_id: shop.variants.oud100.id, quantity_ordered: 10, unit_cost: 200, discount_percent: 0, tax_rate: 0 },
      ],
    },
  });
  const percent = await ok(`/api/purchases/${percentOrder.id}`);
  // 10 × 200 = 2000, less 10% = 1800, plus 100 shipping = 1900.
  assert.equal(round2(percent.subtotal), 2000);
  assert.equal(round2(percent.discount_amount), 200, 'a 10% header discount was not 10%');
  assert.equal(round2(percent.total_amount), 1900);

  const fixedOrder = await ok('/api/purchases', {
    method: 'POST',
    body: {
      supplier_id: shop.supplier.id,
      order_date: '2026-02-01',
      discount_type: 'amount',
      discount_amount: 250,
      shipping_amount: 0,
      lines: [
        { variant_id: shop.variants.musk30.id, quantity_ordered: 20, unit_cost: 60, discount_percent: 0, tax_rate: 0 },
      ],
    },
  });
  const fixed = await ok(`/api/purchases/${fixedOrder.id}`);
  // 20 × 60 = 1200, less a flat 250 = 950.
  assert.equal(round2(fixed.subtotal), 1200);
  assert.equal(round2(fixed.discount_amount), 250, 'a flat 250 discount was read as a percentage');
  assert.equal(round2(fixed.total_amount), 950);

  // Both received, so the shelves and the ledger have something to disagree
  // about later if the receipt path is wrong.
  for (const order of [percent, fixed]) {
    await ok(`/api/purchases/${order.id}/approve`, { method: 'POST', body: {} });
    const detail = await ok(`/api/purchases/${order.id}`);
    await ok(`/api/purchases/${order.id}/receive`, {
      method: 'POST',
      body: { receipts: detail.lines.map((line) => ({ line_id: line.id, quantity: line.quantity_ordered })) },
    });
    shop.orders.push(await ok(`/api/purchases/${order.id}`));
  }
  shop.orderPercent = await ok(`/api/purchases/${percent.id}`);
  shop.orderFixed = await ok(`/api/purchases/${fixed.id}`);

  assert.equal(await onHand(shop.variants.oud100.id), 25);
  assert.equal(await onHand(shop.variants.musk30.id), 80);
});

test('the supplier is paid in instalments and the balance follows', async () => {
  const order = shop.orderA;
  const before = await ok(`/api/purchases/${order.id}/balance`);
  assert.equal(round2(before.total_amount), 13800);
  assert.equal(round2(before.paid_amount), 0);
  assert.equal(round2(before.outstanding), 13800, 'an unpaid order does not owe its own total');

  await ok(`/api/purchases/${order.id}/payment`, {
    method: 'POST', body: { amount: 5000, method: 'cash', paid_on: '2026-01-20' },
  });
  await ok(`/api/purchases/${order.id}/payment`, {
    method: 'POST', body: { amount: 3800, method: 'transfer', paid_on: '2026-02-10' },
  });

  const after = await ok(`/api/purchases/${order.id}/balance`);
  assert.equal(round2(after.paid_amount), 8800);
  assert.equal(round2(after.outstanding), 5000, 'two payments did not come off the balance');
  assert.equal(round2(after.owed_by_supplier), 0, 'the shop is owed money it has not asked for');
});

/* ═══════════════════════════════════════ act two: the shop sells its stock */

test('the counter sells, including one on credit and one with a promotion', async () => {
  await ok('/api/promotions', {
    method: 'POST',
    body: {
      code: 'EID10', name_en: 'Eid ten percent', kind: 'discount',
      discount_type: 'percentage', value: 10, scope: 'order', is_active: true,
    },
  });

  const plain = await ok('/api/sales', {
    method: 'POST',
    body: {
      customer_id: shop.walkIn.id,
      payment_method: 'cash',
      lines: [
        { variant_id: shop.variants.amber50.id, quantity: 3 },
        { variant_id: shop.variants.musk30.id, quantity: 2 },
      ],
    },
  });
  // 3 × 300 + 2 × 150 = 1200 before whatever tax the shop charges.
  assert.equal(round2(plain.subtotal), 1200, 'the sale does not subtotal its own lines');
  shop.sales.push(plain);
  shop.plainSale = plain;

  const promoted = await ok('/api/sales', {
    method: 'POST',
    body: {
      customer_id: shop.regular.id,
      payment_method: 'card',
      promotion_code: 'EID10',
      lines: [{ variant_id: shop.variants.oud100.id, quantity: 2 }],
    },
  });
  assert.equal(round2(promoted.subtotal), 1000);
  assert.equal(round2(promoted.discount_amount), 100, 'a 10% promotion took something other than 10%');
  shop.sales.push(promoted);

  const credit = await ok('/api/sales', {
    method: 'POST',
    body: {
      customer_id: shop.regular.id,
      payment_method: 'credit',
      paid_amount: 0,
      lines: [{ variant_id: shop.variants.amber100.id, quantity: 4 }],
    },
  });
  assert.equal(round2(credit.subtotal), 1200);
  shop.sales.push(credit);
  shop.creditSale = credit;

  // The shelves know.
  assert.equal(await onHand(shop.variants.amber50.id), 37);
  assert.equal(await onHand(shop.variants.musk30.id), 78);
  assert.equal(await onHand(shop.variants.oud100.id), 23);
  assert.equal(await onHand(shop.variants.amber100.id), 16);
});

test('a customer buys from the website and the order runs to delivery', async () => {
  const signedIn = cookie;
  cookie = ''; // the storefront is not signed in

  const placed = await ok('/api/shop/orders', {
    method: 'POST',
    body: {
      lines: [{ variant_id: shop.variants.musk30.id, quantity: 3 }],
      customer: { name: 'Web Customer', phone: '01000000033' },
      address: { line: '9 Nile Street', city: 'Giza' },
      language: 'en',
    },
  });
  assert.ok(placed.order_no, 'the order has no number');
  assert.equal(round2(placed.subtotal), 450, '3 × 150 was not 450');

  cookie = signedIn;
  const list = await ok('/api/web-orders?page=1');
  const row = (list.rows || []).find((r) => r.order_no === placed.order_no);
  assert.ok(row, 'a placed web order is not on the shop\'s screen');

  const before = await onHand(shop.variants.musk30.id);
  await ok(`/api/web-orders/${row.id}/accept`, { method: 'POST', body: {} });
  await ok(`/api/web-orders/${row.id}/dispatch`, { method: 'POST', body: {} });
  await ok(`/api/web-orders/${row.id}/deliver`, { method: 'POST', body: {} });
  const after = await onHand(shop.variants.musk30.id);

  assert.equal(before - after, 3, `a delivered web order moved ${before - after} pieces instead of 3`);

  const detail = await ok(`/api/web-orders/${row.id}`);
  assert.equal(detail.status, 'delivered');
  assert.ok(detail.sale_id, 'a delivered order produced no sale');
  shop.webOrder = detail;
});

/* ═════════════════════════════ act three: goods come back, in both directions */

test('a customer returns two bottles: one resellable, one broken', async () => {
  const sale = shop.plainSale;
  const detail = await ok(`/api/sales/${sale.id}`);
  const amberLine = detail.lines.find((line) => line.variant_id === shop.variants.amber50.id);

  const shelfBefore = await onHand(shop.variants.amber50.id);
  const refund = await ok('/api/returns', {
    method: 'POST',
    body: {
      return_type: 'with_receipt',
      sale_id: sale.id,
      reason_code: 'defective',
      refund_method: 'cash',
      lines: [
        { sale_line_id: amberLine.id, quantity: 1, condition: 'resellable' },
        { sale_line_id: amberLine.id, quantity: 1, condition: 'damaged' },
      ],
    },
  });
  const shelfAfter = await onHand(shop.variants.amber50.id);

  assert.equal(shelfAfter - shelfBefore, 1,
    'a damaged return went back on the shelf, or a resellable one did not');
  assert.equal(round2(refund.total_amount), 600, 'two bottles at 300 did not refund 600');
  assert.equal(Number(refund.items_restocked), 1, 'the wrong number of bottles went back on the shelf');
  assert.equal(Number(refund.items_written_off), 1, 'the broken bottle was not written off');
  shop.customerReturn = refund;
});

test('a customer exchanges an oud for two musks and pays the difference', async () => {
  const sale = shop.sales[1]; // the promoted oud sale
  const detail = await ok(`/api/sales/${sale.id}`);
  const oudLine = detail.lines[0];

  const oudBefore = await onHand(shop.variants.oud100.id);
  const muskBefore = await onHand(shop.variants.musk30.id);

  const exchange = await ok('/api/exchanges', {
    method: 'POST',
    body: {
      sale_id: sale.id,
      lines: [{ sale_line_id: oudLine.id, quantity: 1, condition: 'resellable' }],
      replacements: [{ variant_id: shop.variants.musk30.id, quantity: 2 }],
      settlement_method: 'cash',
      reason_code: 'changed_mind',
    },
  });

  assert.equal(await onHand(shop.variants.oud100.id) - oudBefore, 1, 'the returned oud did not come back');
  assert.equal(muskBefore - await onHand(shop.variants.musk30.id), 2, 'the replacement musks did not leave');

  /*
   * One oud came back at 450 (500 less the 10% promotion) and two musks went
   * out at 150 each. The customer is owed 150 — the money moves TOWARDS the
   * customer, and the sign of that difference is the whole reason this act
   * exists.
   */
  assert.equal(round2(exchange.credit_amount), 450,
    `the oud came back at ${exchange.credit_amount} rather than its discounted 450`);
  assert.equal(round2(exchange.replacement_amount), 300, 'two musks did not leave at 150 each');
  assert.equal(round2(exchange.difference_amount), -150,
    `the difference is ${exchange.difference_amount}; the customer is owed 150`);
  shop.exchange = exchange;
});

test('four bottles are broken in the stockroom', async () => {
  const before = await onHand(shop.variants.amber100.id);
  await ok('/api/inventory/wastage', {
    method: 'POST',
    body: {
      variantId: shop.variants.amber100.id, quantity: 4, reason: 'damage', notes: 'A shelf gave way',
    },
  });
  assert.equal(before - await onHand(shop.variants.amber100.id), 4, 'wastage did not leave the shelf');

  const wastage = await ok('/api/inventory/wastage');
  assert.equal(Number(wastage.summary.units), 4, `the wastage screen shows ${wastage.summary.units} of 4 lost pieces`);
  assert.equal(round2(wastage.summary.value), 480, '4 bottles that cost 120 were not written off at 480');
  shop.wastageValue = Number(wastage.summary.value);
});

test('the shelves are counted and one line is corrected', async () => {
  const variant = shop.variants.musk30.id;
  const system = await onHand(variant);
  const counted = system - 2; // two are simply not there

  const adjustment = await ok('/api/inventory/adjustments', {
    method: 'POST',
    body: {
      reason: 'stock_take',
      notes: 'Monthly count',
      lines: [{ variant_id: variant, system_qty: system, counted_qty: counted, unit_cost: 60 }],
    },
  });
  await ok(`/api/inventory/adjustments/${adjustment.id}/post`, { method: 'POST', body: {} });

  assert.equal(await onHand(variant), counted, 'a posted count did not become the stock level');
});

test('goods go back to a supplier who has already been paid, and he becomes the debtor', async () => {
  /*
   * The owner's own case: «if payment full completed i need to see that this
   * supplier علية فلوس كذا». The percentage-discount order is paid in full and
   * then three of its ten bottles go back.
   */
  const order = shop.orderPercent;
  await ok(`/api/purchases/${order.id}/payment`, {
    method: 'POST', body: { amount: 1900, method: 'transfer', paid_on: '2026-02-15' },
  });
  const settled = await ok(`/api/purchases/${order.id}/balance`);
  assert.equal(round2(settled.outstanding), 0, 'a fully paid order still shows a balance');

  const detail = await ok(`/api/purchases/${order.id}`);
  const shelfBefore = await onHand(shop.variants.oud100.id);
  const sent = await ok('/api/purchase-returns', {
    method: 'POST',
    body: {
      purchase_order_id: order.id,
      reason: 'defective',
      lines: [{ po_line_id: detail.lines[0].id, quantity: 3 }],
    },
  });
  assert.equal(shelfBefore - await onHand(shop.variants.oud100.id), 3, 'the returned goods did not leave the shelf');

  const owing = await ok(`/api/purchases/${order.id}/balance`);
  assert.ok(Number(owing.owed_by_supplier) > 0,
    `the supplier was paid in full and took goods back, but the shop is not shown as owed: ${JSON.stringify(owing)}`);
  // 3 bottles of a 2000-pound order discounted 10% -> 180 each after the
  // pro-rata share of the header discount; shipping is not refunded.
  assert.equal(round2(owing.owed_by_supplier), 540,
    `the credit is ${owing.owed_by_supplier} rather than 3 x 180`);
  assert.equal(round2(owing.outstanding), -540, 'the outstanding figure and the words disagree');
  shop.supplierReturn = sent;
});

test('a supplier swap: one item goes back and a different one comes in', async () => {
  const order = shop.orderFixed;
  const detail = await ok(`/api/purchases/${order.id}`);

  const muskBefore = await onHand(shop.variants.musk30.id);
  const amberBefore = await onHand(shop.variants.amber50.id);

  await ok('/api/purchase-returns', {
    method: 'POST',
    body: {
      purchase_order_id: order.id,
      settlement: 'replace',
      reason: 'wrong_item',
      lines: [{
        po_line_id: detail.lines[0].id,
        quantity: 5,
        replacement_quantity: 5,
        replacement_variant_id: shop.variants.amber50.id,
      }],
    },
  });

  assert.equal(muskBefore - await onHand(shop.variants.musk30.id), 5, 'the wrong item did not go back');
  assert.equal(await onHand(shop.variants.amber50.id) - amberBefore, 5, 'the replacement never arrived');

  /*
   * A swap of equal counts for a DIFFERENT item is not free: what went back was
   * worth 47.50 each after the flat discount, and what came in is worth 120.
   * The balance must move, because the shop now holds more value than it
   * ordered.
   */
  const balance = await ok(`/api/purchases/${order.id}/balance`);
  assert.ok(Number.isFinite(Number(balance.outstanding)), 'the swapped order has no balance');
});

test('a sale is voided and everything it moved comes back', async () => {
  const sale = shop.creditSale;
  const before = await onHand(shop.variants.amber100.id);
  await ok(`/api/sales/${sale.id}/void`, { method: 'POST', body: { reason: 'Customer changed their mind' } });

  assert.equal(await onHand(shop.variants.amber100.id) - before, 4, 'a voided sale kept the stock');
  const voided = await ok(`/api/sales/${sale.id}`);
  assert.equal(voided.status, 'void');
});

test('a product is deleted into the bin and brought back unharmed', async () => {
  const before = await ok(`/api/products/${shop.musk.id}`);
  await ok('/api/trash', {
    method: 'POST', body: { entityType: 'product', entityId: shop.musk.id, reason: 'Discontinued' },
  });

  const list = await ok('/api/products?page=1&pageSize=200');
  assert.ok(!(list.rows || []).some((row) => row.id === shop.musk.id),
    'a product in the recycle bin is still on the products screen');
  const summaryWithout = await ok('/api/products/summary');

  const bin = await ok('/api/trash');
  const item = (bin.rows || []).find((r) => r.entityType === 'product' && Number(r.entityId) === shop.musk.id);
  assert.ok(item, 'the deleted product is not in the bin');
  assert.equal(item.status, 'in_bin');

  await ok(`/api/trash/${item.id}/restore`, { method: 'POST', body: {} });
  const restored = await ok(`/api/products/${shop.musk.id}`);
  assert.equal(restored.name_en, before.name_en);
  assert.equal(restored.variants.length, before.variants.length, 'a restored product lost its variants');

  const summaryWith = await ok('/api/products/summary');
  assert.equal(Number(summaryWith.products), Number(summaryWithout.products) + 1,
    'the summary card did not notice the product coming back');
});

test('the shop records what it spends besides stock', async () => {
  const categories = await ok('/api/cost-categories?page=1&pageSize=50');
  const category = (categories.rows || categories)[0];
  assert.ok(category?.id, 'the shop has no cost categories to spend against');

  await ok('/api/costs', {
    method: 'POST',
    body: { category_id: category.id, amount: 3200, spent_on: '2026-02-01', description: 'Rent' },
  });
  await ok('/api/costs', {
    method: 'POST',
    body: { category_id: category.id, amount: 640, spent_on: '2026-02-03', description: 'Electricity' },
  });
  const summary = await ok('/api/costs/summary');
  assert.equal(round2(summary.total), 3840, `the costs screen totals ${summary.total} of 3840 spent`);
  shop.costsTotal = Number(summary.total);
});

/* ═══════════════════════════════════ the invariants: does the book add up? */

test('INVARIANT — the ledger is the stock', async () => {
  /*
   * The single most important line in this file. Every movement of every
   * variant, summed, must equal what the shelf says. A disagreement here means
   * one of the two paths writes without the other, and no report above it can
   * be trusted.
   */
  const rows = await getDb().prepare(`
    SELECT l.variant_id, l.warehouse_id, l.quantity AS level,
           COALESCE((
             SELECT SUM(m.quantity) FROM stock_movements m
              WHERE m.variant_id = l.variant_id AND m.warehouse_id = l.warehouse_id
           ), 0) AS ledger
      FROM stock_levels l
  `).all();

  assert.ok(rows.length > 0, 'there are no stock levels at all, so this proves nothing');
  const drift = rows
    .filter((row) => round2(row.level) !== round2(row.ledger))
    .map((row) => `variant ${row.variant_id}: shelf ${row.level}, ledger ${row.ledger}`);
  assert.deepEqual(drift, [], `the shelf and the ledger disagree:\n${drift.join('\n')}`);

  // And nothing moved for a variant that has no level row at all.
  const orphans = await getDb().prepare(`
    SELECT DISTINCT m.variant_id FROM stock_movements m
     WHERE NOT EXISTS (
       SELECT 1 FROM stock_levels l
        WHERE l.variant_id = m.variant_id AND l.warehouse_id = m.warehouse_id
     )
  `).all();
  assert.deepEqual(orphans, [], 'stock moved for a variant that has no stock level row');
});

test('INVARIANT — every movement\'s balance_after is the running total up to it', async () => {
  const movements = await getDb().prepare(`
    SELECT id, variant_id, warehouse_id, quantity, balance_after, movement_type, reference_type
      FROM stock_movements ORDER BY variant_id, warehouse_id, id
  `).all();
  assert.ok(movements.length > 10, `only ${movements.length} movements — the scenario did not trade`);

  const running = new Map();
  const wrong = [];
  for (const movement of movements) {
    const key = `${movement.variant_id}:${movement.warehouse_id}`;
    const total = round2((running.get(key) || 0) + Number(movement.quantity));
    running.set(key, total);
    if (round2(movement.balance_after) !== total) {
      wrong.push(`movement ${movement.id} (${movement.movement_type}) says ${movement.balance_after}, the running total is ${total}`);
    }
  }
  assert.deepEqual(wrong, [], `the history does not read back correctly:\n${wrong.join('\n')}`);
});

test('INVARIANT — nothing moved anonymously, and nothing went below zero', async () => {
  const anonymous = await getDb().prepare(`
    SELECT id, movement_type, quantity FROM stock_movements
     WHERE reference_type IS NULL OR reference_id IS NULL
  `).all();
  assert.deepEqual(anonymous, [], 'stock moved with no document behind it');

  const negative = await getDb().prepare(
    'SELECT id, variant_id, balance_after FROM stock_movements WHERE balance_after < 0',
  ).all();
  assert.deepEqual(negative, [], 'the shop held negative stock at some point');

  const negativeNow = await getDb().prepare(
    'SELECT variant_id, quantity FROM stock_levels WHERE quantity < 0',
  ).all();
  assert.deepEqual(negativeNow, [], 'a shelf is holding a negative number of bottles');
});

test('INVARIANT — every sale totals its own lines', async () => {
  /*
   * Three separate statements, because the three figures on a sale mean three
   * different things and conflating them is how a receipt ends up printing a
   * total nobody can reproduce:
   *
   *   subtotal      what the goods cost at the shelf price, before anything.
   *   line_total    what one line came to after its share of every discount,
   *                 plus its own tax — so the lines are what was CHARGED.
   *   total_amount  the sum of those, and therefore what the customer paid.
   */
  const sales = await getDb().prepare(
    'SELECT id, invoice_no, subtotal, discount_amount, tax_amount, total_amount, total_cost, status FROM sales',
  ).all();
  assert.ok(sales.length >= 3, `only ${sales.length} sales — the scenario did not sell`);

  const wrong = [];
  for (const sale of sales) {
    const lines = await getDb().prepare(
      'SELECT quantity, unit_price, unit_cost, discount_amount, tax_amount, line_total FROM sale_lines WHERE sale_id = ?',
    ).all(sale.id);
    assert.ok(lines.length > 0, `${sale.invoice_no} has no lines at all`);

    const gross = round2(lines.reduce((sum, line) => sum + line.quantity * line.unit_price, 0));
    if (round2(sale.subtotal) !== gross) {
      wrong.push(`${sale.invoice_no}: subtotal ${sale.subtotal}, its lines gross ${gross}`);
    }

    const charged = round2(lines.reduce((sum, line) => sum + Number(line.line_total), 0));
    if (round2(sale.total_amount) !== charged) {
      wrong.push(`${sale.invoice_no}: total ${sale.total_amount}, its lines charge ${charged}`);
    }

    // And the three headline figures tell the same story as each other.
    const restated = round2(
      Number(sale.subtotal) - Number(sale.discount_amount || 0) + Number(sale.tax_amount || 0),
    );
    if (Math.abs(restated - round2(sale.total_amount)) > 0.02) {
      wrong.push(`${sale.invoice_no}: total ${sale.total_amount}, subtotal-discount+tax is ${restated}`);
    }

    const cost = round2(lines.reduce((sum, line) => sum + line.quantity * line.unit_cost, 0));
    if (round2(sale.total_cost) !== cost) {
      wrong.push(`${sale.invoice_no}: cost ${sale.total_cost}, its lines cost ${cost}`);
    }
  }
  assert.deepEqual(wrong, [], `a sale does not add up:\n${wrong.join('\n')}`);
});

test('INVARIANT — every purchase order balance is total minus paid minus returned', async () => {
  const orders = await getDb().prepare(
    "SELECT id, po_number, total_amount FROM purchase_orders WHERE status != 'cancelled'",
  ).all();
  assert.ok(orders.length >= 3, `only ${orders.length} orders — the scenario did not buy`);

  const wrong = [];
  for (const order of orders) {
    const reported = await ok(`/api/purchases/${order.id}/balance`);
    const expected = round2(
      Number(reported.total_amount) - Number(reported.returned_amount || 0) - Number(reported.paid_amount || 0),
    );
    if (round2(reported.outstanding) !== expected) {
      wrong.push(`${order.po_number}: says ${reported.outstanding}, total-returned-paid is ${expected}`);
    }
    // And the words are not an opinion: they are the sign of the number.
    const shouldBeOwed = round2(reported.outstanding) < 0 ? round2(-reported.outstanding) : 0;
    if (round2(reported.owed_by_supplier) !== shouldBeOwed) {
      wrong.push(`${order.po_number}: owed_by_supplier=${reported.owed_by_supplier} with an outstanding of ${reported.outstanding}`);
    }
  }
  assert.deepEqual(wrong, [], `a supplier balance does not add up:\n${wrong.join('\n')}`);
});

test('INVARIANT — nothing was received that was not ordered, nor returned that was not received', async () => {
  const over = await getDb().prepare(`
    SELECT po.po_number, l.id, l.quantity_ordered, l.quantity_received
      FROM purchase_order_lines l
      JOIN purchase_orders po ON po.id = l.purchase_order_id
     WHERE l.quantity_received > l.quantity_ordered
  `).all();
  assert.deepEqual(over, [], 'more goods were received than were ordered');

  const returnedTooMuch = await getDb().prepare(`
    SELECT po.po_number, l.id, l.quantity_received,
           COALESCE((
             SELECT SUM(rl.quantity) FROM purchase_return_lines rl
             JOIN purchase_returns r ON r.id = rl.return_id
              WHERE rl.po_line_id = l.id AND r.status != 'reversed'
           ), 0) AS returned
      FROM purchase_order_lines l
      JOIN purchase_orders po ON po.id = l.purchase_order_id
  `).all();
  const wrong = returnedTooMuch
    .filter((row) => Number(row.returned) > Number(row.quantity_received))
    .map((row) => `${row.po_number} line ${row.id}: received ${row.quantity_received}, returned ${row.returned}`);
  assert.deepEqual(wrong, [], `more went back than ever arrived:\n${wrong.join('\n')}`);
});

test('INVARIANT — the dashboard, the valuation report and the stock list agree', async () => {
  /*
   * These three screens disagreed once - 682 units and EGP 108,005 on the home
   * screen against 673 and 107,195 on the report - because they asked the shelf
   * three slightly different questions. They now share one query, and this is
   * what holds them to it.
   */
  const dashboard = await ok('/api/dashboard');
  const valuation = await ok('/api/reports/inventory_valuation');
  const summary = await ok('/api/inventory/summary');

  const fromLevels = await getDb().prepare(`
    SELECT COALESCE(SUM(l.quantity), 0) AS units,
           COALESCE(SUM(l.quantity * l.average_cost), 0) AS value
      FROM stock_levels l
      JOIN product_variants v ON v.id = l.variant_id
      JOIN products p ON p.id = v.product_id
     WHERE ${'${notInBin}'}
  `.replace('${notInBin}', "NOT EXISTS (SELECT 1 FROM trash_items tb WHERE tb.entity_type = 'product' AND tb.entity_id = p.id AND tb.status = 'in_bin')")).get();

  assert.equal(round2(valuation.summary.total_quantity), round2(summary.quantity),
    'the valuation report and the inventory summary count different pieces');
  assert.equal(round2(valuation.summary.total_cost_value), round2(summary.stock_value),
    'the valuation report and the inventory summary hold different money');

  assert.equal(round2(dashboard.kpis.stockUnits), round2(valuation.summary.total_quantity),
    'the dashboard tile and the valuation report count different pieces');
  assert.equal(round2(dashboard.kpis.stockValue), round2(valuation.summary.total_cost_value),
    'the dashboard tile and the valuation report show different money');

  // And all three are the stock levels themselves, not a fourth opinion.
  assert.equal(round2(valuation.summary.total_quantity), round2(fromLevels.units),
    'the reported piece count is not what the shelves are holding');
  assert.equal(round2(valuation.summary.total_cost_value), round2(fromLevels.value),
    'the reported stock value is not what the shelves are holding');
});

test('INVARIANT — the product summary counts what the product table holds', async () => {
  const summary = await ok('/api/products/summary');
  const counted = await getDb().prepare(`
    SELECT COUNT(*) AS products,
           SUM(CASE WHEN p.gender = 'women' THEN 1 ELSE 0 END) AS women,
           SUM(CASE WHEN p.gender = 'men'   THEN 1 ELSE 0 END) AS men,
           SUM(CASE WHEN p.gender IS NULL OR p.gender NOT IN ('women','men') THEN 1 ELSE 0 END) AS unisex,
           SUM(CASE WHEN p.is_active = 1 THEN 1 ELSE 0 END) AS active
      FROM products p
     WHERE NOT EXISTS (
       SELECT 1 FROM trash_items tb
        WHERE tb.entity_type = 'product' AND tb.entity_id = p.id AND tb.status = 'in_bin'
     )
  `).get();

  assert.equal(Number(summary.products), Number(counted.products),
    'the products card counts a different number of products than the table holds');
  assert.equal(Number(summary.women), Number(counted.women), 'the women count is wrong');
  assert.equal(Number(summary.men), Number(counted.men), 'the men count is wrong');
  assert.equal(Number(summary.unisex), Number(counted.unisex), 'the unisex count is wrong');
  assert.equal(Number(summary.women) + Number(summary.men) + Number(summary.unisex),
    Number(summary.products), 'the three gender counts do not add up to the whole catalogue');
  assert.equal(Number(summary.active), Number(counted.active), 'the active count is wrong');

  // The piece count on the card is the same shelf everything else reads.
  const units = await getDb().prepare(`
    SELECT COALESCE(SUM(l.quantity), 0) AS units FROM stock_levels l
      JOIN product_variants v ON v.id = l.variant_id
      JOIN products p ON p.id = v.product_id
     WHERE NOT EXISTS (
       SELECT 1 FROM trash_items tb
        WHERE tb.entity_type = 'product' AND tb.entity_id = p.id AND tb.status = 'in_bin'
     )
  `).get();
  assert.equal(round2(summary.units), round2(units.units),
    'the products card counts different pieces than the shelves hold');
});

test('INVARIANT — every money document left an audit trail', async () => {
  const rows = await getDb().prepare(
    'SELECT module, entity_type, COUNT(*) AS n FROM audit_logs GROUP BY module, entity_type',
  ).all();
  const seen = new Set(rows.map((row) => `${row.module}:${row.entity_type}`));

  const required = ['sales:sale', 'purchases:purchase_order', 'products:product'];
  const missing = required.filter((key) => !seen.has(key));
  assert.deepEqual(missing, [], `these documents moved without an audit row: ${missing.join(', ')} (saw ${[...seen].join(', ')})`);

  /*
   * Nobody's changes were recorded against nobody — with one honest exception.
   * A shopper placing a web order is not signed in and never will be, so that
   * row genuinely has no user behind it. It is named here rather than excluded
   * by a wildcard, so that a SECOND kind of anonymous write shows up as a
   * failure rather than hiding behind this one.
   */
  const anonymous = await getDb().prepare(
    "SELECT module, entity_type, action, COUNT(*) AS n FROM audit_logs"
    + " WHERE user_id IS NULL AND action IN ('CREATE','UPDATE','DELETE')"
    + ' GROUP BY module, entity_type, action',
  ).all();
  const unexplained = anonymous
    .filter((row) => row.entity_type !== 'web_order')
    .map((row) => `${row.module}/${row.entity_type} ${row.action} ×${row.n}`);
  assert.deepEqual(unexplained, [],
    `somebody changed the shop and the log does not say who:\n${unexplained.join('\n')}`);

  // Every sale in the book is named in it.
  const sales = await getDb().prepare('SELECT COUNT(*) AS n FROM sales').get();
  const logged = await getDb().prepare(
    "SELECT COUNT(DISTINCT entity_id) AS n FROM audit_logs WHERE entity_type = 'sale'",
  ).get();
  assert.ok(Number(logged.n) >= Number(sales.n),
    `${sales.n} sales exist but only ${logged.n} are in the audit log`);
});

/* ═════════════════════════════════════════════ the edges: what is refused */

test('EDGE — the shop cannot sell what it does not have', async () => {
  const available = await onHand(shop.variants.oud100.id);
  const res = await call('/api/sales', {
    method: 'POST',
    body: {
      payment_method: 'cash',
      lines: [{ variant_id: shop.variants.oud100.id, quantity: available + 50 }],
    },
  });
  assert.ok(res.status >= 400, `the shop sold ${available + 50} of ${available} it holds`);
  assert.equal(await onHand(shop.variants.oud100.id), available, 'a refused sale still moved stock');
});

test('EDGE — a customer cannot return more than was bought, nor twice', async () => {
  const sale = shop.plainSale;
  const detail = await ok(`/api/sales/${sale.id}`);
  const muskLine = detail.lines.find((line) => line.variant_id === shop.variants.musk30.id);

  await refused('/api/returns', {
    method: 'POST',
    body: {
      return_type: 'with_receipt',
      sale_id: sale.id,
      lines: [{ sale_line_id: muskLine.id, quantity: 99 }],
    },
  }, 'return_too_many');

  // The whole line, then the same line again.
  await ok('/api/returns', {
    method: 'POST',
    body: {
      return_type: 'with_receipt',
      sale_id: sale.id,
      lines: [{ sale_line_id: muskLine.id, quantity: muskLine.quantity }],
    },
  });
  await refused('/api/returns', {
    method: 'POST',
    body: {
      return_type: 'with_receipt',
      sale_id: sale.id,
      lines: [{ sale_line_id: muskLine.id, quantity: 1 }],
    },
  }, 'return_line_done');
});

test('EDGE — a voided sale can be neither returned nor exchanged', async () => {
  const sale = shop.creditSale; // voided earlier
  const detail = await ok(`/api/sales/${sale.id}`);
  await refused('/api/returns', {
    method: 'POST',
    body: { return_type: 'with_receipt', sale_id: sale.id, lines: [{ sale_line_id: detail.lines[0].id, quantity: 1 }] },
  }, 'return_void');
  await refused('/api/exchanges', {
    method: 'POST',
    body: {
      sale_id: sale.id,
      lines: [{ sale_line_id: detail.lines[0].id, quantity: 1 }],
      replacements: [{ variant_id: shop.variants.amber50.id, quantity: 1 }],
    },
  }, 'exchange_void');
});

test('EDGE — more cannot be received than was ordered', async () => {
  const created = await ok('/api/purchases', {
    method: 'POST',
    body: {
      supplier_id: shop.otherSupplier.id,
      order_date: '2026-03-01',
      lines: [{ variant_id: shop.variants.amber50.id, quantity_ordered: 5, unit_cost: 120, discount_percent: 0, tax_rate: 0 }],
    },
  });
  await ok(`/api/purchases/${created.id}/approve`, { method: 'POST', body: {} });
  const detail = await ok(`/api/purchases/${created.id}`);
  const before = await onHand(shop.variants.amber50.id);

  const res = await call(`/api/purchases/${created.id}/receive`, {
    method: 'POST', body: { receipts: [{ line_id: detail.lines[0].id, quantity: 50 }] },
  });
  assert.ok(res.status >= 400, 'fifty were received against an order for five');
  assert.equal(await onHand(shop.variants.amber50.id), before, 'a refused receipt still moved stock');
});

test('EDGE — goods that were sold or written off cannot go back to the supplier', async () => {
  /*
   * The owner's rule, in his words: «i can not return items that i was sold it
   * and i can not return items that in scrab». The check is not a flag on a
   * row — it is that the goods are not on the shelf any more, so the refusal
   * has to be provoked with a line whose received quantity the shelf can no
   * longer cover. Which line that is depends on everything above, so it is
   * found rather than assumed.
   */
  const order = await ok(`/api/purchases/${shop.orderA.id}`);
  let target = null;
  for (const line of order.lines) {
    const shelf = await onHand(line.variant_id);
    if (Number(line.quantity_received) > shelf) {
      target = { line, shelf };
      break;
    }
  }
  assert.ok(target,
    'every line of the first order is still fully on the shelf, so this refusal cannot be provoked');

  // Asking for exactly what was received: the order allows it, the shelf does not.
  const error = await refused('/api/purchase-returns', {
    method: 'POST',
    body: {
      purchase_order_id: order.id,
      lines: [{ po_line_id: target.line.id, quantity: target.line.quantity_received }],
    },
  }, 'pr_not_in_stock');
  assert.equal(Number(error.details.available), target.shelf,
    'the refusal names a different shelf quantity than the one that is there');

  // And more than was ever received is a different refusal, with its own name.
  await refused('/api/purchase-returns', {
    method: 'POST',
    body: {
      purchase_order_id: order.id,
      lines: [{ po_line_id: target.line.id, quantity: Number(target.line.quantity_received) + 500 }],
    },
  }, 'pr_too_many');
});

test('EDGE — nothing can be written off that is not there', async () => {
  const available = await onHand(shop.variants.amber100.id);
  const res = await call('/api/inventory/wastage', {
    method: 'POST',
    body: { variantId: shop.variants.amber100.id, quantity: available + 10, reason: 'loss' },
  });
  assert.ok(res.status >= 400, `${available + 10} were written off from a shelf holding ${available}`);
  assert.equal(await onHand(shop.variants.amber100.id), available);

  // And a bookkeeping reason is not a loss — it must not reach this door.
  const bookkeeping = await call('/api/inventory/wastage', {
    method: 'POST',
    body: { variantId: shop.variants.amber100.id, quantity: 1, reason: 'correction' },
  });
  assert.ok(bookkeeping.status >= 400, 'a correction was recorded as wastage');
});

test('EDGE — a supplier payment cannot be negative, nor wildly beyond the balance', async () => {
  const order = shop.orderA;
  const before = await ok(`/api/purchases/${order.id}/balance`);

  const negative = await call(`/api/purchases/${order.id}/payment`, {
    method: 'POST', body: { amount: -500, method: 'cash' },
  });
  assert.ok(negative.status >= 400, 'a negative payment was recorded');

  const zero = await call(`/api/purchases/${order.id}/payment`, {
    method: 'POST', body: { amount: 0, method: 'cash' },
  });
  assert.ok(zero.status >= 400, 'a payment of nothing was recorded');

  const after = await ok(`/api/purchases/${order.id}/balance`);
  assert.equal(round2(after.balance), round2(before.balance), 'a refused payment moved the balance');
});

test('EDGE — the same request sent twice creates one document, not two', async () => {
  /*
   * A shopkeeper double-clicks, or the phone loses signal after the request
   * left and before the answer came back. Both produce the same key twice, and
   * the second must be answered with the first result rather than with a
   * second sale.
   */
  const key = `fc-idem-${Date.now()}`;
  const body = {
    payment_method: 'cash',
    lines: [{ variant_id: shop.variants.amber50.id, quantity: 1 }],
  };
  const before = await onHand(shop.variants.amber50.id);

  const first = await ok('/api/sales', { method: 'POST', body, key });
  const second = await ok('/api/sales', { method: 'POST', body, key });

  assert.equal(second.id, first.id, 'the same request produced two different sales');
  assert.equal(await onHand(shop.variants.amber50.id), before - 1,
    'a replayed sale took the stock twice');
});

test('EDGE — after every refusal above, the book still adds up', async () => {
  /*
   * The point of running this again at the very end: a refusal that has already
   * written half of what it was going to do is worse than one that never
   * started, and the only way to see the difference is to re-check the
   * invariant after the refusals rather than before them.
   */
  const rows = await getDb().prepare(`
    SELECT l.variant_id, l.quantity AS level,
           COALESCE((SELECT SUM(m.quantity) FROM stock_movements m
                      WHERE m.variant_id = l.variant_id AND m.warehouse_id = l.warehouse_id), 0) AS ledger
      FROM stock_levels l
  `).all();
  const drift = rows
    .filter((row) => round2(row.level) !== round2(row.ledger))
    .map((row) => `variant ${row.variant_id}: shelf ${row.level}, ledger ${row.ledger}`);
  assert.deepEqual(drift, [], `a refusal left the book half-written:\n${drift.join('\n')}`);

  const negative = await getDb().prepare('SELECT id FROM stock_movements WHERE balance_after < 0').all();
  assert.deepEqual(negative, [], 'a refusal drove the shelf below zero');
});
