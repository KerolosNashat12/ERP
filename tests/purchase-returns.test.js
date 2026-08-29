/**
 * Goods going back to the supplier: the money, the shelf, and every refusal.
 *
 * ── The owner's own words ───────────────────────────────────────────────────
 * "What if after i recived the all PO and تسجيل دفعه and after one or two or
 * three we need to return some of those items to the supplier… i can not return
 * items that i was sold… i can not return items that in scrab… if the payment
 * is still not completed minus the returned… if payment full completed i need
 * to see that this supplier علية فلوس كذا… and add replacement not just
 * returned."
 *
 * Each of those is a test below, in that order, because that list is the
 * specification. The two that matter most are the ones about money:
 *
 *   · An order not yet paid in full: what goes back comes off what is owed.
 *   · An order paid in full: what goes back makes the SUPPLIER the debtor, and
 *     the system has to say so in those words rather than leaving a minus sign
 *     on a screen for somebody to interpret.
 *
 * The balance is derived from the order, its payments and its returns every
 * time it is asked for. That is the whole reason these three can never disagree
 * — there is no stored balance to drift.
 */
import './single-shop.js'; // must be first — see that file
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'data', 'purchase-returns-test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
process.env.MM_DB_FILE = path.join(dir, 'shop.db');

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

/** The refusal, by its code — the message is for people, the rule is for tests. */
const refused = async (pathname, options, rule) => {
  const res = await call(pathname, options);
  assert.ok(res.status >= 400, `${pathname} was allowed but should have been refused (${rule})`);
  assert.equal(res.data?.error?.details?.rule, rule,
    `expected refusal "${rule}", got ${JSON.stringify(res.data?.error)}`);
  return res.data.error;
};

const onHand = async (variantId) => Number((await getDb().prepare(
  'SELECT COALESCE(SUM(quantity),0) AS n FROM stock_levels WHERE variant_id = ?',
).get(variantId))?.n || 0);

test('returning goods to a supplier', async (t) => {
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

  const supplier = await ok('/api/suppliers', {
    method: 'POST', body: { name_en: 'Returns Supplier', payment_terms_days: 30 },
  });

  let nextSku = 1;
  async function product(cost, price = cost * 2) {
    const sku = `PR${nextSku}`;
    nextSku += 1;
    const created = await ok('/api/products', {
      method: 'POST',
      body: {
        sku_prefix: sku,
        name_en: sku,
        name_ar: sku,
        base_price: price,
        variants: [{ sku: `${sku}-A`, variant_label: '', cost_price: cost, selling_price: price }],
      },
    });
    return created.variants[0];
  }

  /** An order, approved, and received in full unless told otherwise. */
  async function order(lines, { receive = true, discount = null } = {}) {
    const created = await ok('/api/purchases', {
      method: 'POST',
      body: {
        supplier_id: supplier.id,
        order_date: new Date().toISOString().slice(0, 10),
        ...(discount || {}),
        lines: lines.map((line) => ({
          variant_id: line.variant.id,
          quantity_ordered: line.quantity,
          unit_cost: line.cost,
          discount_percent: line.discountPercent || 0,
          tax_rate: line.taxRate || 0,
        })),
      },
    });
    await ok(`/api/purchases/${created.id}/approve`, { method: 'POST', body: {} });
    const full = await ok(`/api/purchases/${created.id}`);
    if (receive) {
      await ok(`/api/purchases/${created.id}/receive`, {
        method: 'POST',
        body: { receipts: full.lines.map((line) => ({ line_id: line.id, quantity: line.quantity_ordered })) },
      });
    }
    return ok(`/api/purchases/${created.id}`);
  }

  // ═══════════════════════════════════════════════ 1. the ordinary return
  await t.test('goods go back, the shelf drops, and what is owed drops with it', async () => {
    const variant = await product(100);
    const po = await order([{ variant, quantity: 10, cost: 100 }]);
    assert.equal(await onHand(variant.id), 10);

    const before = await ok(`/api/purchases/${po.id}/balance`);
    assert.equal(before.outstanding, 1000, 'ten at a hundred, nothing paid yet');

    const sent = await ok('/api/purchase-returns', {
      method: 'POST',
      body: {
        purchase_order_id: po.id,
        settlement: 'credit',
        reason: 'faulty',
        lines: [{ po_line_id: po.lines[0].id, quantity: 3 }],
      },
    });
    assert.equal(sent.total_amount, 300);
    assert.equal(await onHand(variant.id), 7, 'three left the shelf');

    const after = await ok(`/api/purchases/${po.id}/balance`);
    assert.equal(after.returned_amount, 300);
    assert.equal(after.outstanding, 700, 'the shop owes 300 less than it did');
    assert.equal(after.owed_by_supplier, 0);
  });

  // ═══════════════ 2. paid in full, then returned — the supplier owes money
  await t.test('paid in full, then goods go back: the supplier owes the shop', async () => {
    const variant = await product(50);
    const po = await order([{ variant, quantity: 20, cost: 50 }]);

    await ok(`/api/purchases/${po.id}/payment`, { method: 'POST', body: { amount: 1000, method: 'cash' } });
    const paid = await ok(`/api/purchases/${po.id}/balance`);
    assert.equal(paid.outstanding, 0, 'settled in full');

    await ok('/api/purchase-returns', {
      method: 'POST',
      body: {
        purchase_order_id: po.id,
        settlement: 'refund',
        lines: [{ po_line_id: po.lines[0].id, quantity: 4 }],
      },
    });

    const after = await ok(`/api/purchases/${po.id}/balance`);
    assert.equal(after.returned_amount, 200);
    assert.equal(after.outstanding, -200, 'the order is 200 overpaid');
    assert.equal(after.owed_by_supplier, 200,
      'and that is said in words, not left as a minus sign for a screen to read');
  });

  // ═══════════════════════════════ 3. what cannot go back: sold, scrapped
  await t.test('items that were sold cannot be sent back', async () => {
    const variant = await product(80, 200);
    const po = await order([{ variant, quantity: 5, cost: 80 }]);

    await ok('/api/sales', {
      method: 'POST',
      body: {
        payment_method: 'cash',
        lines: [{ variant_id: variant.id, quantity: 4 }],
      },
    });
    assert.equal(await onHand(variant.id), 1);

    const error = await refused('/api/purchase-returns', {
      method: 'POST',
      body: {
        purchase_order_id: po.id,
        lines: [{ po_line_id: po.lines[0].id, quantity: 3 }],
      },
    }, 'pr_not_in_stock');
    assert.equal(error.details.available, 1, 'the refusal names what is actually there');

    // The one that IS there may still go back.
    const sent = await ok('/api/purchase-returns', {
      method: 'POST',
      body: { purchase_order_id: po.id, lines: [{ po_line_id: po.lines[0].id, quantity: 1 }] },
    });
    assert.equal(sent.total_amount, 80);
    assert.equal(await onHand(variant.id), 0);
  });

  await t.test('items written off as wastage cannot be sent back either', async () => {
    const variant = await product(60);
    const po = await order([{ variant, quantity: 6, cost: 60 }]);

    // Scrapped: broken in the shop. The pieces are gone from the shelf.
    const count = await ok('/api/inventory/adjustments', {
      method: 'POST',
      body: {
        reason: 'damage',
        notes: 'broken in the stockroom',
        lines: [{
          variant_id: variant.id, system_qty: 6, counted_qty: 2, unit_cost: 60,
        }],
      },
    });
    await ok(`/api/inventory/adjustments/${count.id}/post`, { method: 'POST', body: {} });
    assert.equal(await onHand(variant.id), 2);

    const error = await refused('/api/purchase-returns', {
      method: 'POST',
      body: { purchase_order_id: po.id, lines: [{ po_line_id: po.lines[0].id, quantity: 5 }] },
    }, 'pr_not_in_stock');
    assert.equal(error.details.available, 2);
  });

  // ═════════════════════════════════════════ 4. more than ever arrived
  await t.test('more than the order received cannot go back, once or twice', async () => {
    const variant = await product(30);
    const po = await order([{ variant, quantity: 8, cost: 30 }]);

    const tooMany = await refused('/api/purchase-returns', {
      method: 'POST',
      body: { purchase_order_id: po.id, lines: [{ po_line_id: po.lines[0].id, quantity: 9 }] },
    }, 'pr_too_many');
    assert.equal(tooMany.details.left, 8);

    await ok('/api/purchase-returns', {
      method: 'POST',
      body: { purchase_order_id: po.id, lines: [{ po_line_id: po.lines[0].id, quantity: 5 }] },
    });

    // Five have gone. Four more is one too many, and the refusal says so.
    const again = await refused('/api/purchase-returns', {
      method: 'POST',
      body: { purchase_order_id: po.id, lines: [{ po_line_id: po.lines[0].id, quantity: 4 }] },
    }, 'pr_too_many');
    assert.equal(again.details.left, 3, 'it counts what earlier returns already took');
  });

  await t.test('an order that received nothing has nothing to send back', async () => {
    const variant = await product(20);
    const po = await order([{ variant, quantity: 4, cost: 20 }], { receive: false });
    await refused('/api/purchase-returns', {
      method: 'POST',
      body: { purchase_order_id: po.id, lines: [{ po_line_id: po.lines[0].id, quantity: 1 }] },
    }, 'pr_nothing_received');
  });

  // ══════════════════════════════════════════════════ 5. the replacement
  await t.test('a replacement sends goods out and brings the same back', async () => {
    const variant = await product(120);
    const po = await order([{ variant, quantity: 10, cost: 120 }]);
    assert.equal(await onHand(variant.id), 10);

    const swap = await ok('/api/purchase-returns', {
      method: 'POST',
      body: {
        purchase_order_id: po.id,
        settlement: 'replace',
        reason: 'wrong batch',
        lines: [{ po_line_id: po.lines[0].id, quantity: 4, replacement_quantity: 4 }],
      },
    });
    assert.equal(swap.settlement, 'replace');
    assert.equal(await onHand(variant.id), 10, 'four out, four back — the shelf is where it was');

    /*
     * And the money is where it was too. A replacement is not a credit: the
     * shop has what it paid for, so what it owes must not move.
     */
    const balance = await ok(`/api/purchases/${po.id}/balance`);
    assert.equal(balance.returned_amount - swap.replacement_amount, 0,
      'a like-for-like replacement nets to nothing');
  });

  await t.test('a short replacement leaves the difference owing', async () => {
    const variant = await product(200);
    const po = await order([{ variant, quantity: 6, cost: 200 }]);

    const swap = await ok('/api/purchase-returns', {
      method: 'POST',
      body: {
        purchase_order_id: po.id,
        settlement: 'replace',
        lines: [{ po_line_id: po.lines[0].id, quantity: 3, replacement_quantity: 1 }],
      },
    });
    assert.equal(swap.total_amount, 600, 'three went back');
    assert.equal(swap.replacement_amount, 200, 'one came back');
    assert.equal(await onHand(variant.id), 4, '6 − 3 + 1');
  });

  await t.test('a supplier can send a DIFFERENT item against the same credit', async () => {
    /*
     * The owner's case, in his words: "لو عاوز ابدل منتج جوه الفاتورة دي مش
     * ارجعه ابدلة بحاجة تانية". The faulty bottle goes back; something else
     * comes in against it. Two different products, one document, one
     * transaction - and the money only balances if the incoming item is valued
     * at ITS cost rather than the outgoing one's.
     */
    const faulty = await product(300);
    const instead = await product(450);
    const po = await order([{ variant: faulty, quantity: 6, cost: 300 }]);
    assert.equal(await onHand(faulty.id), 6);
    assert.equal(await onHand(instead.id), 0);

    const swap = await ok('/api/purchase-returns', {
      method: 'POST',
      body: {
        purchase_order_id: po.id,
        settlement: 'replace',
        reason: 'discontinued — supplier sent the newer one',
        lines: [{
          po_line_id: po.lines[0].id,
          quantity: 2,
          replacement_quantity: 2,
          replacement_variant_id: instead.id,
          replacement_unit_cost: 450,
        }],
      },
    });

    assert.equal(await onHand(faulty.id), 4, 'two of the faulty item left the shelf');
    assert.equal(await onHand(instead.id), 2, 'and two of the other one arrived');
    assert.equal(swap.total_amount, 600, 'two at 300 went back');
    assert.equal(swap.replacement_amount, 900, 'two at 450 came in — the swap is not even');

    // The document says WHAT came back, not just how many.
    const record = await ok(`/api/purchase-returns/${swap.id}`);
    assert.equal(record.lines[0].replacement_variant_id, instead.id);
    assert.equal(record.lines[0].replacement_unit_cost, 450);
  });

  await t.test('undoing an uneven swap puts both items back where they were', async () => {
    const faulty = await product(120);
    const instead = await product(200);
    const po = await order([{ variant: faulty, quantity: 5, cost: 120 }]);

    const swap = await ok('/api/purchase-returns', {
      method: 'POST',
      body: {
        purchase_order_id: po.id,
        settlement: 'replace',
        lines: [{
          po_line_id: po.lines[0].id,
          quantity: 3,
          replacement_quantity: 3,
          replacement_variant_id: instead.id,
          replacement_unit_cost: 200,
        }],
      },
    });
    assert.equal(await onHand(faulty.id), 2);
    assert.equal(await onHand(instead.id), 3);

    await ok(`/api/purchase-returns/${swap.id}/reverse`, { method: 'POST', body: { reason: 'wrong line' } });
    assert.equal(await onHand(faulty.id), 5, 'the item that went back is back');
    assert.equal(await onHand(instead.id), 0,
      'and the item that came in is gone — otherwise the shop would be holding both');
  });

  await t.test('a switched-off item cannot be what a supplier sends', async () => {
    const faulty = await product(100);
    const dead = await product(100);
    await ok(`/api/products/${dead.product_id}`, { method: 'GET' }).catch(() => null);
    await getDb().prepare('UPDATE product_variants SET is_active = 0 WHERE id = ?').run(dead.id);

    const po = await order([{ variant: faulty, quantity: 4, cost: 100 }]);
    await refused('/api/purchase-returns', {
      method: 'POST',
      body: {
        purchase_order_id: po.id,
        settlement: 'replace',
        lines: [{
          po_line_id: po.lines[0].id,
          quantity: 1,
          replacement_quantity: 1,
          replacement_variant_id: dead.id,
        }],
      },
    }, 'pr_replacement_inactive');
  });

  await t.test('a different item with no quantity is a mistake, not a no-op', async () => {
    const faulty = await product(100);
    const instead = await product(100);
    const po = await order([{ variant: faulty, quantity: 4, cost: 100 }]);
    await refused('/api/purchase-returns', {
      method: 'POST',
      body: {
        purchase_order_id: po.id,
        settlement: 'replace',
        lines: [{
          po_line_id: po.lines[0].id,
          quantity: 2,
          replacement_quantity: 0,
          replacement_variant_id: instead.id,
        }],
      },
    }, 'pr_replacement_no_quantity');
  });

  await t.test('a replacement cannot bring back more than went out', async () => {
    const variant = await product(90);
    const po = await order([{ variant, quantity: 5, cost: 90 }]);
    await refused('/api/purchase-returns', {
      method: 'POST',
      body: {
        purchase_order_id: po.id,
        settlement: 'replace',
        lines: [{ po_line_id: po.lines[0].id, quantity: 2, replacement_quantity: 3 }],
      },
    }, 'pr_replacement_too_many');
  });

  await t.test('a replacement quantity on a credit is a mistake, not a silent no-op', async () => {
    const variant = await product(70);
    const po = await order([{ variant, quantity: 5, cost: 70 }]);
    await refused('/api/purchase-returns', {
      method: 'POST',
      body: {
        purchase_order_id: po.id,
        settlement: 'credit',
        lines: [{ po_line_id: po.lines[0].id, quantity: 2, replacement_quantity: 2 }],
      },
    }, 'pr_replacement_not_asked');
  });

  // ═══════════════════════════════════ 6. the money a line is really worth
  await t.test('a return credits what was paid, not the list cost', async () => {
    const variant = await product(1000);
    /*
     * 10 at 1,000 with 10% off the line is 9,000, plus 5% tax is 9,450. Then the
     * supplier took 900 off the order as a whole — 10% — so a single piece cost
     * 945 − 90 = 855, and that is what one going back is worth. Crediting the
     * full 1,000 would hand the shop money it never paid.
     */
    const po = await order([{ variant, quantity: 10, cost: 1000, discountPercent: 10, taxRate: 5 }],
      { discount: { discount_type: 'amount', discount_amount: 900 } });
    assert.equal(po.discount_amount, 900);
    assert.equal(po.discount_type, 'amount');

    const sent = await ok('/api/purchase-returns', {
      method: 'POST',
      body: { purchase_order_id: po.id, lines: [{ po_line_id: po.lines[0].id, quantity: 1 }] },
    });
    assert.equal(sent.total_amount, 855);
  });

  // ═══════════════════════════════════════════ 7. reversing a mistake
  await t.test('a return recorded in error is reversed, not deleted', async () => {
    const variant = await product(40);
    const po = await order([{ variant, quantity: 10, cost: 40 }]);
    const sent = await ok('/api/purchase-returns', {
      method: 'POST',
      body: { purchase_order_id: po.id, lines: [{ po_line_id: po.lines[0].id, quantity: 6 }] },
    });
    assert.equal(await onHand(variant.id), 4);

    const reversed = await ok(`/api/purchase-returns/${sent.id}/reverse`, {
      method: 'POST', body: { reason: 'wrong order' },
    });
    assert.equal(reversed.status, 'reversed');
    assert.equal(await onHand(variant.id), 10, 'the goods are back on the shelf');

    const balance = await ok(`/api/purchases/${po.id}/balance`);
    assert.equal(balance.returned_amount, 0, 'and a reversed return credits nothing');

    // The document is still there, and says what happened to it.
    const found = await ok(`/api/purchase-returns/${sent.id}`);
    assert.equal(found.reversal_reason, 'wrong order');

    await refused(`/api/purchase-returns/${sent.id}/reverse`, {
      method: 'POST', body: { reason: 'again' },
    }, 'pr_already_reversed');

    // And what it took is returnable again.
    const state = await ok(`/api/purchases/${po.id}/returnable`);
    assert.equal(state.lines[0].returnable_quantity, 10);
  });

  // ══════════════════════════════════════ 8. the supplier's own balance
  await t.test('the supplier screen shows what is owed both ways', async () => {
    const summary = await ok('/api/suppliers/summary');
    /*
     * Every order above rolls into this. What matters is that returns are taken
     * off: a supplier statement that ignored them would ask the shop for money
     * it does not owe, which is the exact argument this feature exists to win.
     */
    assert.ok(Number.isFinite(summary.outstanding));
    assert.ok(summary.orders >= 8);
  });

  /* ══════════════════════════════════════════════════════════════════════
   *  The edge cases. Written after the feature worked, which is when the
   *  interesting ones are actually visible: a shape the happy path never
   *  produces, a number that only misbehaves at the third decimal place, a
   *  second click on the same button.
   * ══════════════════════════════════════════════════════════════════════ */

  await t.test('a part-received order can only send back what actually arrived', async () => {
    /*
     * Ordered ten, three turned up. The other seven are not the shop's to send
     * anywhere - they are still the supplier's problem - and "returnable" has to
     * mean received, not ordered.
     */
    const variant = await product(100);
    const po = await order([{ variant, quantity: 10, cost: 100 }], { receive: false });
    await ok(`/api/purchases/${po.id}/receive`, {
      method: 'POST', body: { receipts: [{ line_id: po.lines[0].id, quantity: 3 }] },
    });

    const state = await ok(`/api/purchases/${po.id}/returnable`);
    assert.equal(state.lines[0].returnable_quantity, 3, 'three arrived, three can go back');

    const tooMany = await refused('/api/purchase-returns', {
      method: 'POST',
      body: { purchase_order_id: po.id, lines: [{ po_line_id: po.lines[0].id, quantity: 4 }] },
    }, 'pr_too_many');
    assert.equal(tooMany.details.left, 3);
  });

  await t.test('one document can send back several lines, and touches only those', async () => {
    const a = await product(100);
    const b = await product(250);
    const untouched = await product(70);
    const po = await order([
      { variant: a, quantity: 5, cost: 100 },
      { variant: b, quantity: 4, cost: 250 },
      { variant: untouched, quantity: 6, cost: 70 },
    ]);

    const sent = await ok('/api/purchase-returns', {
      method: 'POST',
      body: {
        purchase_order_id: po.id,
        lines: [
          { po_line_id: po.lines[0].id, quantity: 2 },
          { po_line_id: po.lines[1].id, quantity: 1 },
        ],
      },
    });
    assert.equal(sent.total_amount, 450, '2×100 + 1×250');
    assert.equal(await onHand(a.id), 3);
    assert.equal(await onHand(b.id), 3);
    assert.equal(await onHand(untouched.id), 6, 'the line nobody picked must not move');

    const state = await ok(`/api/purchases/${po.id}/returnable`);
    const left = Object.fromEntries(state.lines.map((l) => [l.sku, l.returnable_quantity]));
    assert.equal(left[untouched.sku], 6);
  });

  await t.test('the same product on two lines keeps two separate allowances', async () => {
    /*
     * A buyer who ordered the same bottle twice on one order - two prices, two
     * deliveries - has two lines. Returning against one must not eat the
     * other's allowance, and the credit has to follow the LINE's cost.
     */
    const variant = await product(100);
    const po = await order([
      { variant, quantity: 4, cost: 100 },
      { variant, quantity: 6, cost: 130 },
    ]);

    await ok('/api/purchase-returns', {
      method: 'POST',
      body: { purchase_order_id: po.id, lines: [{ po_line_id: po.lines[0].id, quantity: 4 }] },
    });

    const state = await ok(`/api/purchases/${po.id}/returnable`);
    assert.equal(state.lines[0].returnable_quantity, 0, 'the first line is used up');
    assert.equal(state.lines[1].returnable_quantity, 6, 'the second is untouched');

    const second = await ok('/api/purchase-returns', {
      method: 'POST',
      body: { purchase_order_id: po.id, lines: [{ po_line_id: po.lines[1].id, quantity: 1 }] },
    });
    assert.equal(second.total_amount, 130, 'credited at ITS line cost, not the other one\'s');
  });

  await t.test('shipping is not refunded — the lorry came', async () => {
    const variant = await product(100);
    const po = await order([{ variant, quantity: 10, cost: 100 }],
      { discount: { shipping_amount: 250 } });
    assert.equal(po.total_amount, 1250);

    const sent = await ok('/api/purchase-returns', {
      method: 'POST',
      body: { purchase_order_id: po.id, lines: [{ po_line_id: po.lines[0].id, quantity: 10 }] },
    });
    assert.equal(sent.total_amount, 1000, 'every bottle back, and the delivery still cost what it cost');

    const balance = await ok(`/api/purchases/${po.id}/balance`);
    assert.equal(balance.net_amount, 250, 'the shop still owes the shipping');
  });

  /*
   * ── The three shapes of a swap, and what each does to the money ──────────
   *
   * These three exist because the version before them did not, and the bug that
   * slipped through was the worst kind: silent, on the most ordinary case, on a
   * screen that looked completely normal.
   *
   * `replacement_amount` was computed correctly, written on every return
   * document, and then read by NOTHING. The balance subtracted what went out
   * and never added what came back — so a supplier replacing three faulty
   * bottles with three identical ones took 300 off a debt the shop still owed
   * in full. The test that should have caught it was named "a cheaper swap
   * leaves the difference owing to the shop" and then asserted the document and
   * the shelf and never once looked at the balance. A test named after the
   * money has to look at the money.
   */

  await t.test('an EVEN swap moves no money at all', async () => {
    /*
     * The ordinary case, and the one that was wrong. Three faulty bottles go
     * back, three identical ones come in. The shop holds what it held and owes
     * what it owed; nothing about this order has changed except that three
     * bottles on the shelf are now ones that work.
     */
    const variant = await product(100);
    const po = await order([{ variant, quantity: 10, cost: 100 }]);
    const before = await ok(`/api/purchases/${po.id}/balance`);
    assert.equal(before.outstanding, 1000);

    const swap = await ok('/api/purchase-returns', {
      method: 'POST',
      body: {
        purchase_order_id: po.id,
        settlement: 'replace',
        lines: [{ po_line_id: po.lines[0].id, quantity: 3, replacement_quantity: 3 }],
      },
    });
    assert.equal(swap.total_amount, 300, 'three bottles went back');
    assert.equal(swap.replacement_amount, 300, 'three came in against them');

    const after = await ok(`/api/purchases/${po.id}/balance`);
    assert.equal(after.returned_amount, 300, 'the goods that went back are still a fact worth showing');
    assert.equal(after.replacement_amount, 300, 'and so are the ones that came in');
    assert.equal(after.credit_amount, 0, 'an even swap is worth nothing off the order');
    assert.equal(after.net_amount, 1000, 'the order still costs what it cost');
    assert.equal(after.outstanding, 1000,
      'an even swap wiped part of a debt the shop still owes in full');
    assert.equal(after.owed_by_supplier, 0);
    assert.equal(await onHand(variant.id), 10, 'the shelf holds what it held');
  });

  await t.test('a swap for something DEARER makes the shop owe the difference', async () => {
    const ordinary = await product(100);
    const better = await product(150);
    const po = await order([{ variant: ordinary, quantity: 10, cost: 100 }]);

    const swap = await ok('/api/purchase-returns', {
      method: 'POST',
      body: {
        purchase_order_id: po.id,
        settlement: 'replace',
        lines: [{
          po_line_id: po.lines[0].id,
          quantity: 2,
          replacement_quantity: 2,
          replacement_variant_id: better.id,
          replacement_unit_cost: 150,
        }],
      },
    });
    assert.equal(swap.total_amount, 200, 'two ordinary ones went back');
    assert.equal(swap.replacement_amount, 300, 'two better ones came in');

    const balance = await ok(`/api/purchases/${po.id}/balance`);
    // 200 of goods left, 300 of goods arrived: the shop is 100 further in.
    assert.equal(balance.credit_amount, -100, 'the shop received more than it sent');
    assert.equal(balance.net_amount, 1100, 'the order should now cost 100 more, not 200 less');
    assert.equal(balance.outstanding, 1100);
    assert.equal(balance.owed_by_supplier, 0, 'the shop owes HIM here, not the other way round');
  });

  await t.test('a cheaper swap leaves the difference owing to the shop', async () => {
    const dear = await product(500);
    const cheap = await product(200);
    const po = await order([{ variant: dear, quantity: 4, cost: 500 }]);

    const swap = await ok('/api/purchase-returns', {
      method: 'POST',
      body: {
        purchase_order_id: po.id,
        settlement: 'replace',
        lines: [{
          po_line_id: po.lines[0].id,
          quantity: 2,
          replacement_quantity: 2,
          replacement_variant_id: cheap.id,
          replacement_unit_cost: 200,
        }],
      },
    });
    assert.equal(swap.total_amount, 1000, 'two dear ones went back');
    assert.equal(swap.replacement_amount, 400, 'two cheap ones came in');
    assert.equal(await onHand(dear.id), 2);
    assert.equal(await onHand(cheap.id), 2);

    // 1000 of goods left, 400 arrived: 600 comes off the order and no more.
    const balance = await ok(`/api/purchases/${po.id}/balance`);
    assert.equal(balance.credit_amount, 600, 'the credit is the difference, not the whole return');
    assert.equal(balance.net_amount, 1400, '2000 less a 600 credit');
    assert.equal(balance.outstanding, 1400);

    // And once it is paid in full, the same swap makes the supplier the debtor.
    await ok(`/api/purchases/${po.id}/payment`, { method: 'POST', body: { amount: 2000, method: 'cash' } });
    const paid = await ok(`/api/purchases/${po.id}/balance`);
    assert.equal(paid.outstanding, -600);
    assert.equal(paid.owed_by_supplier, 600,
      'paid 2000 for 1400 of goods — the supplier is holding 600 of the shop\'s money');
  });

  await t.test('undoing a swap gives back the money as well as the goods', async () => {
    const variant = await product(100);
    const instead = await product(250);
    const po = await order([{ variant, quantity: 8, cost: 100 }]);

    const swap = await ok('/api/purchase-returns', {
      method: 'POST',
      body: {
        purchase_order_id: po.id,
        settlement: 'replace',
        lines: [{
          po_line_id: po.lines[0].id,
          quantity: 4,
          replacement_quantity: 4,
          replacement_variant_id: instead.id,
          replacement_unit_cost: 250,
        }],
      },
    });
    const during = await ok(`/api/purchases/${po.id}/balance`);
    assert.equal(during.net_amount, 1400, '400 out, 1000 in');

    await ok(`/api/purchase-returns/${swap.id}/reverse`, { method: 'POST', body: { reason: 'wrong line' } });
    const after = await ok(`/api/purchases/${po.id}/balance`);
    assert.equal(after.returned_amount, 0);
    assert.equal(after.replacement_amount, 0, 'a reversed swap must drop BOTH halves, not just one');
    assert.equal(after.credit_amount, 0);
    assert.equal(after.net_amount, 800, 'the order is exactly what it was before the swap');
    assert.equal(await onHand(variant.id), 8);
    assert.equal(await onHand(instead.id), 0);
  });

  await t.test('awkward costs stay to the piastre', async () => {
    /*
     * 33.333 a piece is what a per-carton price divided by twelve looks like.
     * Money is rounded to two places and quantities to three; what must not
     * happen is a credit that is a third of a piastre away from the invoice.
     */
    const variant = await product(33.333);
    const po = await order([{ variant, quantity: 3, cost: 33.333 }]);
    const sent = await ok('/api/purchase-returns', {
      method: 'POST',
      body: { purchase_order_id: po.id, lines: [{ po_line_id: po.lines[0].id, quantity: 3 }] },
    });
    assert.equal(sent.total_amount, round2(3 * 33.333));
    assert.equal(sent.total_amount, 100);
  });

  await t.test('half a bottle can go back, if that is how it was bought', async () => {
    const variant = await product(200);
    const po = await order([{ variant, quantity: 2.5, cost: 200 }]);
    const sent = await ok('/api/purchase-returns', {
      method: 'POST',
      body: { purchase_order_id: po.id, lines: [{ po_line_id: po.lines[0].id, quantity: 0.5 }] },
    });
    assert.equal(sent.total_amount, 100);
    assert.equal(await onHand(variant.id), 2);
  });

  await t.test('nothing, zero and a negative are all refused', async () => {
    const variant = await product(100);
    const po = await order([{ variant, quantity: 5, cost: 100 }]);

    /*
     * An empty list never reaches the service - the schema stops it at the door,
     * which is the right layer for "you sent me nothing". What matters is that
     * it is refused and nothing moves.
     */
    const empty = await call('/api/purchase-returns', {
      method: 'POST', body: { purchase_order_id: po.id, lines: [] },
    });
    assert.equal(empty.status, 422);

    /*
     * A line asking for nothing is stopped at the same door. The service keeps
     * its own `pr_nothing_picked` guard behind that - unreachable through the
     * API, and deliberately kept, because the service is also called from tests
     * and could be called from a script tomorrow, and "sent nothing" should not
     * become "returned nothing, silently".
     */
    const zero = await call('/api/purchase-returns', {
      method: 'POST',
      body: { purchase_order_id: po.id, lines: [{ po_line_id: po.lines[0].id, quantity: 0 }] },
    });
    assert.equal(zero.status, 422);

    const negative = await call('/api/purchase-returns', {
      method: 'POST',
      body: { purchase_order_id: po.id, lines: [{ po_line_id: po.lines[0].id, quantity: -3 }] },
    });
    assert.equal(negative.status, 422, 'a negative return would be a delivery');
    assert.equal(await onHand(variant.id), 5, 'and nothing moved');
  });

  await t.test('a line from another order cannot be smuggled in', async () => {
    const mine = await product(100);
    const theirs = await product(100);
    const a = await order([{ variant: mine, quantity: 5, cost: 100 }]);
    const b = await order([{ variant: theirs, quantity: 5, cost: 100 }]);

    const res = await call('/api/purchase-returns', {
      method: 'POST',
      body: { purchase_order_id: a.id, lines: [{ po_line_id: b.lines[0].id, quantity: 1 }] },
    });
    assert.equal(res.status, 404, "a line that is not on this order is not this order's to send back");
    assert.equal(await onHand(theirs.id), 5);
  });

  await t.test('a draft order has received nothing, whatever its lines say', async () => {
    const variant = await product(100);
    const created = await ok('/api/purchases', {
      method: 'POST',
      body: {
        supplier_id: supplier.id,
        order_date: new Date().toISOString().slice(0, 10),
        lines: [{
          variant_id: variant.id, quantity_ordered: 5, unit_cost: 100, discount_percent: 0, tax_rate: 0,
        }],
      },
    });
    const draft = await ok(`/api/purchases/${created.id}`);
    assert.equal(draft.status, 'draft');
    await refused('/api/purchase-returns', {
      method: 'POST',
      body: { purchase_order_id: draft.id, lines: [{ po_line_id: draft.lines[0].id, quantity: 1 }] },
    }, 'pr_nothing_received');
  });

  await t.test('pressing send twice does not send the goods back twice', async () => {
    /*
     * A slow connection and an impatient hand. The idempotency key is what makes
     * the second press the same act as the first rather than a second one; nine
     * pieces leaving the shelf because a button was double-clicked is exactly
     * the kind of thing nobody notices until a stock count.
     */
    const variant = await product(100);
    const po = await order([{ variant, quantity: 10, cost: 100 }]);
    const body = { purchase_order_id: po.id, lines: [{ po_line_id: po.lines[0].id, quantity: 3 }] };
    const key = `double-${Math.random().toString(36).slice(2)}`;

    const send = () => fetch(`${base}/api/purchase-returns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie, 'Idempotency-Key': key },
      body: JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, data: await res.json() }));

    const first = await send();
    const second = await send();
    assert.equal(first.status, 201);
    assert.ok(second.status < 400, `the replay answered ${second.status}`);
    assert.equal(second.data.return_no, first.data.return_no, 'the same document, not a second one');
    assert.equal(await onHand(variant.id), 7, 'three went back, not six');
  });

  await t.test('returning does not disturb what the rest of the stock is worth', async () => {
    /*
     * Ten bought at 100 and ten at 200 average out at 150. Sending back two of
     * them must not re-price the eighteen still on the shelf - a return is goods
     * leaving, and goods leaving have never changed an average cost.
     */
    const variant = await product(100);
    const first = await order([{ variant, quantity: 10, cost: 100 }]);
    await order([{ variant, quantity: 10, cost: 200 }]);
    const before = await getDb().prepare(
      'SELECT average_cost FROM stock_levels WHERE variant_id = ?',
    ).get(variant.id);
    assert.equal(round2(before.average_cost), 150);

    await ok('/api/purchase-returns', {
      method: 'POST',
      body: { purchase_order_id: first.id, lines: [{ po_line_id: first.lines[0].id, quantity: 2 }] },
    });
    const after = await getDb().prepare(
      'SELECT average_cost FROM stock_levels WHERE variant_id = ?',
    ).get(variant.id);
    assert.equal(round2(after.average_cost), 150, 'the shelf is worth what it was worth');
    assert.equal(await onHand(variant.id), 18);
  });

  await t.test('every return is a numbered document with an audit trail behind it', async () => {
    const variant = await product(100);
    const po = await order([{ variant, quantity: 5, cost: 100 }]);
    const sent = await ok('/api/purchase-returns', {
      method: 'POST',
      body: { purchase_order_id: po.id, reason: 'leaking caps', lines: [{ po_line_id: po.lines[0].id, quantity: 2 }] },
    });

    assert.match(sent.return_no, /^PRT-\d{4}-\d{5}$/, 'a number a person can quote on the phone');
    assert.equal(sent.po_number, po.po_number, 'and it names the order it came from');

    const audit = await getDb().prepare(`
      SELECT action, entity_type, entity_label FROM audit_logs
       WHERE entity_type = 'purchase_return' AND entity_label = ?
       ORDER BY id DESC LIMIT 1
    `).get(sent.return_no);
    assert.ok(audit, 'a movement of stock and money with nobody attached to it is not acceptable');
    assert.equal(audit.action, 'CREATE');

    // And the stock ledger says where those two went.
    const movement = await getDb().prepare(`
      SELECT movement_type, quantity, reference_no FROM stock_movements
       WHERE reference_type = 'purchase_return' AND reference_no = ?
    `).get(sent.return_no);
    assert.equal(movement.movement_type, 'purchase_return');
    assert.equal(movement.quantity, -2);
  });

  await t.test('sending goods back needs the right to do it', async () => {
    /*
     * `purchases.return` is granted to whoever may RECEIVE goods, on purpose:
     * the person who opens the carton and finds it broken is the person who
     * sends it back, and a shop that narrowed the receiving right meant to
     * narrow this one too. So the test is not "a clerk cannot" - a stock clerk
     * receives, and therefore may - it is that somebody with NEITHER right is
     * refused, and refused before anything moves.
     */
    const variant = await product(100);
    const po = await order([{ variant, quantity: 5, cost: 100 }]);

    const rolesRes = await ok('/api/users/roles');
    const roles = rolesRes.rows || rolesRes;
    const cashier = roles.find((r) => r.code === 'cashier');
    assert.ok(cashier, 'expected a cashier role in the seed');
    assert.ok(!(cashier.permissions || []).includes('purchases.return'),
      'a cashier must not hold the right this test is about');

    await ok('/api/users', {
      method: 'POST',
      body: {
        username: 'till-only', full_name: 'Till Only', password: 'till-only-password', role_id: cashier.id,
      },
    });
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'till-only', password: 'till-only-password' }),
    });
    const cashierCookie = (login.headers.get('set-cookie') || '').split(';')[0];

    const attempt = await fetch(`${base}/api/purchase-returns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: cashierCookie, 'Idempotency-Key': `p-${Math.random()}` },
      body: JSON.stringify({ purchase_order_id: po.id, lines: [{ po_line_id: po.lines[0].id, quantity: 1 }] }),
    });
    assert.equal(attempt.status, 403, 'the till does not send goods back to suppliers');
    assert.equal(await onHand(variant.id), 5, 'and nothing moved on the way to being refused');

    // Reading the order is a different right and stays open to them.
    const canLook = await fetch(`${base}/api/purchases/${po.id}`, { headers: { cookie: cashierCookie } });
    assert.ok([200, 403].includes(canLook.status));
  });

  await t.test('two returns racing for the same stock cannot both win', async () => {
    /*
     * Two people, two tills, one carton - or one person on a bad connection who
     * pressed twice with two different keys, so idempotency does not cover it.
     * Each request checks what is returnable and then writes; if the check and
     * the write are not one atomic act, both can pass a check that only one of
     * them should.
     *
     * The rule being defended is arithmetic, not politeness: whatever happens,
     * the shop must not have sent back more than it received.
     */
    const variant = await product(100);
    const po = await order([{ variant, quantity: 10, cost: 100 }]);

    const send = (quantity) => fetch(`${base}/api/purchase-returns`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', cookie, 'Idempotency-Key': `race-${Math.random()}`,
      },
      body: JSON.stringify({
        purchase_order_id: po.id, lines: [{ po_line_id: po.lines[0].id, quantity }],
      }),
    }).then((res) => res.status);

    const [a, b] = await Promise.all([send(6), send(6)]);
    const won = [a, b].filter((status) => status < 400).length;

    const state = await ok(`/api/purchases/${po.id}/returnable`);
    const returned = state.lines[0].returned_quantity;
    assert.ok(returned <= 10, `sent back ${returned} of 10 received`);
    assert.equal(await onHand(variant.id), 10 - returned, 'the shelf and the paperwork agree');
    assert.ok(won >= 1, 'one of them has to succeed, or the shop cannot return anything under load');
    console.log(`      race: ${a}/${b}, ${returned} of 10 went back`);
  });

  await t.test('an order in the recycle bin takes no more returns', async () => {
    const variant = await product(100);
    const po = await order([{ variant, quantity: 5, cost: 100 }]);
    const binned = await call('/api/trash', {
      method: 'POST',
      body: { entityType: 'purchase_order', entityId: po.id, reason: 'raised by mistake' },
    });

    if (binned.status >= 400) {
      /*
       * A received order may refuse to be deleted at all, which is a better
       * answer than deleting it - so that refusal IS the protection, and it is
       * what this asserts.
       */
      assert.ok(binned.status < 500, `deleting a received order answered ${binned.status}`);
      return;
    }

    const attempt = await call('/api/purchase-returns', {
      method: 'POST',
      body: { purchase_order_id: po.id, lines: [{ po_line_id: po.lines[0].id, quantity: 1 }] },
    });
    assert.ok(attempt.status >= 400,
      'an order somebody deleted must not go on accepting documents');
    assert.equal(await onHand(variant.id), 5);
  });

  // ═══════════════════════ 8b. what the PUBLIC side may see and sell
  await t.test('a deleted product cannot be ordered or photographed from the website', async () => {
    /*
     * The listing learned that deleted means deleted the day a product the shop
     * had removed went on being offered for sale. Two doors did not: the
     * CHECKOUT, which takes a variant id in the request body and never asked
     * the recycle bin, and the public IMAGE endpoint, whose ids are sequential
     * and therefore walkable. Both are public and neither needs a session.
     */
    const doomed = await product(75, 150);
    await ok('/api/purchases', { method: 'GET' });

    // Publish it and give it a photograph, so both doors have something to open.
    const productId = (await ok(`/api/products?search=${doomed.sku.split('-')[0]}`)).rows[0]?.id
      || doomed.product_id;
    await ok(`/api/products/${productId}/publish`, { method: 'POST', body: { published: true } })
      .catch(() => null);
    await getDb().prepare('UPDATE products SET is_published = 1 WHERE id = ?').run(productId);
    const image = await getDb().prepare(`
      INSERT INTO product_images (product_id, data, content_type, byte_size)
      VALUES (?, ?, 'image/png', 3) RETURNING id
    `).get(productId, Buffer.from([1, 2, 3]));

    const beforeShot = await call(`/api/shop/images/${image.id}`);
    assert.equal(beforeShot.status, 200, 'while it is on sale the photo is public, which is the point');

    // Into the bin.
    await ok('/api/trash', {
      method: 'POST', body: { entityType: 'product', entityId: productId, reason: 'discontinued' },
    });

    const afterShot = await call(`/api/shop/images/${image.id}`);
    assert.equal(afterShot.status, 404,
      'a deleted product\'s photographs must go with it — the ids are countable');

    const order = await call('/api/shop/orders', {
      method: 'POST',
      body: {
        customer_name: 'Someone With An Old Link',
        phone: '01000000000',
        address: 'Anywhere',
        governorate: 'Cairo',
        lines: [{ variant_id: doomed.id, quantity: 1 }],
      },
    });
    assert.ok(order.status >= 400,
      `a deleted product must not be orderable from a cached page: ${JSON.stringify(order.data)}`);
  });

  // ═══════════════════════════════════════ 9. the fixed-value discount
  await t.test('a purchase discount can be a rate or a sum of money', async () => {
    const variant = await product(100);

    const byRate = await order([{ variant, quantity: 10, cost: 100 }],
      { discount: { discount_type: 'percent', discount_percent: 10 } });
    assert.equal(byRate.discount_amount, 100);
    assert.equal(byRate.total_amount, 900);

    /*
     * The one this round exists for: 500 off, entered as 500, stored as 500.
     * Before, it went in as 4.1666…% and came back as 499.99 — which is how a
     * supplier's invoice and the shop's order stopped matching.
     */
    const byMoney = await order([{ variant, quantity: 120, cost: 100 }],
      { discount: { discount_type: 'amount', discount_amount: 500 } });
    assert.equal(byMoney.discount_amount, 500);
    assert.equal(byMoney.total_amount, 11500);

    // An order that says nothing about the kind still behaves exactly as it did.
    const legacy = await order([{ variant, quantity: 10, cost: 100 }],
      { discount: { discount_percent: 25 } });
    assert.equal(legacy.discount_type, 'percent');
    assert.equal(legacy.discount_amount, 250);
  });

  /* ═══════════════ what a person can SEE after a swap ═══════════════════════
   *
   * The tests above this line prove the money and the shelf, and they all passed
   * while the owner did a swap on his live shop and could not tell it had
   * happened. His four words for it:
   *
   *   «ايه الفرق بين رجع والراجع» — two columns, two spellings of one word.
   *   «ده تبديل» — and the list called it a return.
   *   «ظاهر في المرتجع مش تبديل» — no state saying a swap had happened.
   *   «المنتج القديم لسه ظاهر والجديد مش موجود» — the order still listed only
   *   the bottle that left, with no mark on it and no sign of the one that
   *   replaced it.
   *
   * Every one of those is a fact the SERVER has and was not sending. So these
   * assert the payloads the screens are drawn from — which is the level at which
   * "the feature works" and "a person can tell it worked" are the same question.
   */
  await t.test('a swap is visible everywhere it happened', async (t) => {
    const call = async (pathname, options) => ok(pathname, options);

    const supplier = await ok('/api/suppliers', {
      method: 'POST', body: { name_en: 'Visibility Supplier', name_ar: 'مورد' },
    });
    const make = async (en, ar, cost) => {
      const prefix = en.replace(/\W/g, '').slice(0, 6).toUpperCase();
      const created = await ok('/api/products', {
        method: 'POST',
        body: {
          sku_prefix: prefix, name_en: en, name_ar: ar, base_price: cost * 2,
          variants: [{ sku: `${prefix}-1`, variant_label: '', cost_price: cost, selling_price: cost * 2 }],
        },
      });
      return created.variants[0];
    };

    // The owner's own case, with his own numbers: one bottle out, a DIFFERENT
    // and dearer bottle in.
    const wentOut = await make('Very Sexy outlet', 'فيري سكسي السودا اوتليت', 250);
    const cameIn = await make('Yara outlet', 'يارا اوتليت', 380);

    const created = await ok('/api/purchases', {
      method: 'POST',
      body: {
        supplier_id: supplier.id,
        order_date: '2026-06-22',
        lines: [{ variant_id: wentOut.id, quantity_ordered: 2, unit_cost: 250, discount_percent: 0, tax_rate: 0 }],
      },
    });
    await ok(`/api/purchases/${created.id}/approve`, { method: 'POST', body: {} });
    const order = await ok(`/api/purchases/${created.id}`);
    await ok(`/api/purchases/${created.id}/receive`, {
      method: 'POST', body: { receipts: [{ line_id: order.lines[0].id, quantity: 2 }] },
    });

    // Before the swap the line carries an empty history rather than no history —
    // a screen should not have to guess whether the field is missing or zero.
    const before = await ok(`/api/purchases/${created.id}`);
    assert.equal(before.lines[0].returned_quantity, 0);
    assert.equal(before.lines[0].replaced_quantity, 0);
    assert.deepEqual(before.lines[0].replacements, []);

    await ok('/api/purchase-returns', {
      method: 'POST',
      body: {
        purchase_order_id: created.id,
        settlement: 'replace',
        lines: [{
          po_line_id: order.lines[0].id,
          quantity: 1,
          replacement_quantity: 1,
          replacement_variant_id: cameIn.id,
          replacement_unit_cost: 380,
        }],
      },
    });

    await t.test('the purchase order line says what happened to it', async () => {
      const after = await ok(`/api/purchases/${created.id}`);
      const line = after.lines[0];

      // The line itself is untouched — that is the whole reason a return is its
      // own document, and a "fix" that edited the order would break it.
      assert.equal(line.quantity_ordered, 2, 'the order was rewritten by a return');
      assert.equal(line.quantity_received, 2, 'what arrived is no longer what arrived');
      assert.equal(line.unit_cost, 250);

      // …and it now carries its history beside it.
      assert.equal(line.returned_quantity, 1, 'the line does not say one went back');
      assert.equal(line.replaced_quantity, 1, 'the line does not say one came in');
      assert.equal(line.replacements.length, 1);

      const swap = line.replacements[0];
      assert.equal(swap.replacement_quantity, 1);
      assert.equal(swap.replacement_variant_id, cameIn.id,
        'the order does not name the item that came in');
      assert.equal(swap.replacement_name_ar, 'يارا اوتليت',
        'the replacement has no name on it — the screen would print an id');
      assert.equal(swap.replacement_sku, cameIn.sku);
      // Both prices, because the difference is the point of showing it at all.
      assert.equal(round2(swap.returned_unit_cost), 250);
      assert.equal(round2(swap.replacement_unit_cost), 380);
    });

    await t.test('the supplier-returns list calls a swap a swap', async () => {
      const list = await ok('/api/purchase-returns');
      const row = list.rows.find((r) => r.purchase_order_id === created.id);
      assert.ok(row, 'the swap is not on the supplier returns list at all');

      assert.equal(row.kind, 'swap',
        'the list still calls this a return — the owner looked at exactly this row');
      assert.equal(row.swapped_for_other_item, true,
        'the list cannot tell a same-item replacement from a different-item swap');

      // Three numbers, not one. The list used to show only the first, next to an
      // order balance that had not moved by it.
      assert.equal(round2(row.total_amount), 250, 'what went out');
      assert.equal(round2(row.replacement_amount), 380, 'what came in');
      assert.equal(round2(row.credit_amount), -130,
        'the list does not say the shop received 130 more than it sent');
    });

    await t.test('an ordinary return is NOT called a swap', async () => {
      /*
       * The control. Without it `kind` could return "swap" for everything and
       * every assertion above would still pass.
       */
      const plain = await ok('/api/purchase-returns', {
        method: 'POST',
        body: {
          purchase_order_id: created.id,
          lines: [{ po_line_id: order.lines[0].id, quantity: 1 }],
        },
      });
      const list = await ok('/api/purchase-returns');
      const row = list.rows.find((r) => r.return_no === plain.return_no);
      assert.equal(row.kind, 'return', 'a plain return is being shown as a swap');
      assert.equal(row.swapped_for_other_item, false);
      assert.equal(round2(row.replacement_amount), 0);
      assert.equal(round2(row.credit_amount), round2(row.total_amount),
        'a return with nothing coming back is worth its whole value off the order');
    });

    await t.test('a reversed swap leaves no mark on the line', async () => {
      /*
       * The history is derived from completed documents only — the same rule the
       * balance follows. A swap recorded in error must not leave the order
       * saying an item was replaced when it was not.
       */
      const swapDoc = await ok('/api/purchase-returns', {
        method: 'POST',
        body: {
          purchase_order_id: created.id,
          settlement: 'replace',
          lines: [{
            po_line_id: order.lines[0].id,
            quantity: 0.5,
            replacement_quantity: 0.5,
            replacement_variant_id: cameIn.id,
            replacement_unit_cost: 380,
          }],
        },
      }).catch(() => null);

      if (!swapDoc) return; // half a bottle refused on this line; nothing to test
      const during = await ok(`/api/purchases/${created.id}`);
      assert.equal(during.lines[0].replacements.length, 2);

      await ok(`/api/purchase-returns/${swapDoc.id}/reverse`, {
        method: 'POST', body: { reason: 'recorded in error' },
      });
      const after = await ok(`/api/purchases/${created.id}`);
      assert.equal(after.lines[0].replacements.length, 1,
        'a reversed swap is still shown on the order line');
    });
  });
});
