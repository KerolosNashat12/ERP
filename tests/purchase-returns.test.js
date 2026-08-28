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
});
