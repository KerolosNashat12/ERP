/**
 * Round 15 end to end: bulk edits, returns of every shape, and exchanges.
 *
 * ── What is being defended ──────────────────────────────────────────────────
 * Three features that all share one property: they are the places where a
 * mistake is expensive and quiet. A bulk edit is one click away from being
 * applied to the wrong two hundred rows. A return puts money back and stock
 * back, and getting either half wrong is invisible until somebody counts. An
 * exchange does both at once, in two directions.
 *
 * So every test here is either an arithmetic check or a REFUSAL. The refusals
 * are the more important half and they are written first, because the whole
 * value of a returns system is what it will not let a tired cashier do at the
 * end of a long day.
 *
 * The owner listed the scenarios himself; each of his lines has a test below.
 */
import './single-shop.js'; // must be first — see that file
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'data', 'returns-exchanges-test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
process.env.MM_DB_FILE = path.join(dir, 'shop.db');

const { createApp } = await import('../src/server.js');
const {
  initDb, closeDb, getDb, applySchema,
} = await import('../src/infrastructure/database/connection.js');
const { seedBaseline } = await import('../src/infrastructure/database/seed.js');
const { runMigrations } = await import('../src/infrastructure/database/migrations/index.js');
const { returnState } = await import('../src/infrastructure/repositories/SalesRepository.js');

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
  assert.ok(res.status < 400, `${pathname} → ${res.status} ${JSON.stringify(res.data)}`);
  return res.data;
};

/** A product with one variant, stocked and priced. */
async function product(name, price, quantity = 20) {
  const created = await ok('/api/products', {
    method: 'POST',
    body: {
      sku_prefix: `${name.replace(/\W/g, '').toUpperCase().slice(0, 6)}${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      name_en: name,
      name_ar: name,
      base_cost: price / 2,
      base_price: price,
      tax_rate: 0,
      is_published: true,
      attribute_ids: [],
      variants: [],
    },
  });
  const variant = created.variants[0];
  await ok('/api/inventory/quick-adjust', {
    method: 'POST',
    body: {
      variantId: variant.id, newQuantity: quantity, reason: 'correction', notes: 'fixture',
    },
  });
  return { ...created, variant };
}

const sell = (lines, paid) => ok('/api/sales', {
  method: 'POST',
  body: { lines, payment_method: 'cash', paid_amount: paid },
});

const onHand = async (variantId) => Number((await getDb().prepare(
  'SELECT COALESCE(SUM(quantity),0) AS n FROM stock_levels WHERE variant_id = ?',
).get(variantId))?.n || 0);

test('bulk edits, returns and exchanges', async (t) => {
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
  });

  cookie = (await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  }).then((res) => res.headers.get('set-cookie'))).split(';')[0];

  // =========================================================== 5. BULK EDITS

  await t.test('bulk: one product, many products, and only the ones chosen', async (ctx) => {
    const a = await product('Bulk One', 100);
    const b = await product('Bulk Two', 100);
    const c = await product('Bulk Three', 100);
    const untouched = await product('Bulk Untouched', 100);

    const genderOf = async (id) => (await getDb()
      .prepare('SELECT gender FROM products WHERE id = ?').get(id)).gender;

    await ctx.test('one', async () => {
      const result = await ok('/api/products/bulk', {
        method: 'POST',
        body: { ids: [a.id], changes: { gender: 'men' } },
      });
      assert.equal(result.changed, 1);
      assert.equal(await genderOf(a.id), 'men');
    });

    await ctx.test('several at once', async () => {
      const result = await ok('/api/products/bulk', {
        method: 'POST',
        body: { ids: [b.id, c.id], changes: { gender: 'women' } },
      });
      assert.equal(result.changed, 2);
      assert.equal(await genderOf(b.id), 'women');
      assert.equal(await genderOf(c.id), 'women');
    });

    await ctx.test('and nothing else in the shop moved', async () => {
      assert.equal(await genderOf(untouched.id), 'unisex',
        'a product that was not selected must not be touched');
    });

    await ctx.test('a product already holding the value is not a change', async () => {
      const result = await ok('/api/products/bulk', {
        method: 'POST',
        body: { ids: [b.id, c.id], changes: { gender: 'women' } },
      });
      assert.equal(result.changed, 0);
      assert.equal(result.unchanged, 2);
    });

    await ctx.test('every change is in the audit log, once', async () => {
      const row = await getDb().prepare(`
        SELECT COUNT(*) AS n FROM audit_logs
         WHERE entity_type = 'product' AND entity_id = ? AND action = 'UPDATE'
      `).get(String(a.id));
      assert.equal(Number(row.n), 1);
    });

    await ctx.test('the classification fields all work the same way', async () => {
      const brand = await ok('/api/brands', {
        method: 'POST',
        body: { code: `BK${Math.random().toString(36).slice(2, 6)}`, name_en: 'Bulk Brand', name_ar: 'ماركة' },
      });
      const result = await ok('/api/products/bulk', {
        method: 'POST',
        body: { ids: [a.id, b.id], changes: { brand_id: brand.id } },
      });
      assert.equal(result.changed, 2);
      const row = await getDb().prepare('SELECT brand_id FROM products WHERE id = ?').get(a.id);
      assert.equal(row.brand_id, brand.id);
    });

    await ctx.test('and clearing one is a real change, not a refusal', async () => {
      await ok('/api/products/bulk', {
        method: 'POST',
        body: { ids: [a.id], changes: { brand_id: null } },
      });
      const row = await getDb().prepare('SELECT brand_id FROM products WHERE id = ?').get(a.id);
      assert.equal(row.brand_id, null);
    });

    await ctx.test('an empty selection, an empty change and a bad value are all refused', async () => {
      assert.equal((await call('/api/products/bulk', {
        method: 'POST', body: { ids: [], changes: { gender: 'men' } },
      })).status, 422);
      assert.equal((await call('/api/products/bulk', {
        method: 'POST', body: { ids: [a.id], changes: {} },
      })).status, 422);
      assert.equal((await call('/api/products/bulk', {
        method: 'POST', body: { ids: [a.id], changes: { gender: 'wizard' } },
      })).status, 422);
    });

    await ctx.test('and a brand that does not exist cannot orphan a batch', async () => {
      const res = await call('/api/products/bulk', {
        method: 'POST', body: { ids: [a.id, b.id], changes: { brand_id: 999_999 } },
      });
      assert.equal(res.status, 404);
      const row = await getDb().prepare('SELECT brand_id FROM products WHERE id = ?').get(b.id);
      assert.notEqual(row.brand_id, 999_999);
    });
  });

  // =================================================== 7/8/9. RETURNS

  await t.test('returns: one line, several, the whole invoice, and every refusal', async (ctx) => {
    const one = await product('Return A', 100);
    const two = await product('Return B', 250);
    const three = await product('Return C', 400);

    const sale = await sell([
      { key: 1, variant_id: one.variant.id, quantity: 3 },
      { key: 2, variant_id: two.variant.id, quantity: 2 },
      { key: 3, variant_id: three.variant.id, quantity: 1 },
    ], 1200);
    assert.equal(sale.total_amount, 1200);

    const lines = (await ok(`/api/sales/${sale.id}`)).lines;
    const lineFor = (item) => lines.find((line) => line.variant_id === item.variant.id);

    await ctx.test('one piece of one line comes back, and only that', async () => {
      const before = await onHand(one.variant.id);
      const refund = await ok('/api/returns', {
        method: 'POST',
        body: {
          return_type: 'with_receipt',
          sale_id: sale.id,
          reason_code: 'changed_mind',
          refund_method: 'cash',
          lines: [{ sale_line_id: lineFor(one).id, quantity: 1, condition: 'resellable' }],
        },
      });
      assert.equal(refund.total_amount, 100, 'one of three at 100 each');
      assert.equal(await onHand(one.variant.id), before + 1);

      const after = await ok(`/api/sales/${sale.id}`);
      assert.equal(after.return_state, 'partial', 'the rest of the invoice is still live');
      assert.equal(after.lines.find((l) => l.id === lineFor(one).id).returned_quantity, 1);
      assert.equal(after.lines.find((l) => l.id === lineFor(two).id).returned_quantity, 0,
        'a line nobody returned is untouched');
    });

    await ctx.test('several lines at once, in one document', async () => {
      const refund = await ok('/api/returns', {
        method: 'POST',
        body: {
          return_type: 'with_receipt',
          sale_id: sale.id,
          reason_code: 'wrong_size',
          refund_method: 'cash',
          lines: [
            { sale_line_id: lineFor(one).id, quantity: 1, condition: 'resellable' },
            { sale_line_id: lineFor(two).id, quantity: 1, condition: 'resellable' },
          ],
        },
      });
      assert.equal(refund.total_amount, 350, '100 + 250');
      assert.equal(refund.lines.length, 2);
    });

    await ctx.test('more than was bought is refused, and says how many are left', async () => {
      const res = await call('/api/returns', {
        method: 'POST',
        body: {
          return_type: 'with_receipt',
          sale_id: sale.id,
          reason_code: 'other',
          refund_method: 'cash',
          lines: [{ sale_line_id: lineFor(one).id, quantity: 5, condition: 'resellable' }],
        },
      });
      assert.ok(res.status >= 400);
      assert.equal(res.data.error.details.rule, 'return_too_many');
      assert.equal(res.data.error.details.left, 1, 'one of the three is still out there');
      assert.equal(res.data.error.details.asked, 5);
    });

    await ctx.test('the rest of the invoice comes back, and it is then full', async () => {
      const fresh = (await ok(`/api/sales/${sale.id}`)).lines;
      const outstanding = fresh
        .map((line) => ({ id: line.id, left: line.quantity - line.returned_quantity }))
        .filter((line) => line.left > 0);
      assert.ok(outstanding.length, 'there is something left to return');

      await ok('/api/returns', {
        method: 'POST',
        body: {
          return_type: 'with_receipt',
          sale_id: sale.id,
          reason_code: 'changed_mind',
          refund_method: 'cash',
          lines: outstanding.map((line) => ({
            sale_line_id: line.id, quantity: line.left, condition: 'resellable',
          })),
        },
      });

      const after = await ok(`/api/sales/${sale.id}`);
      assert.equal(after.return_state, 'full', 'every line is back');
      assert.equal(returnState(after.lines), 'full', 'and the rule agrees with the API');
    });

    await ctx.test('a line already fully returned says so in its own words', async () => {
      const res = await call('/api/returns', {
        method: 'POST',
        body: {
          return_type: 'with_receipt',
          sale_id: sale.id,
          reason_code: 'other',
          refund_method: 'cash',
          lines: [{ sale_line_id: lineFor(two).id, quantity: 1, condition: 'resellable' }],
        },
      });
      assert.ok(res.status >= 400);
      // The invoice-level refusal wins: telling the cashier "this whole invoice
      // is already back" is more use than a complaint about one line.
      assert.equal(res.data.error.details.rule, 'return_all_done');
      assert.match(JSON.stringify(res.data), /INV-/);
    });

    await ctx.test('and the same return cannot be made twice', async () => {
      const again = await call('/api/returns', {
        method: 'POST',
        body: {
          return_type: 'with_receipt',
          sale_id: sale.id,
          reason_code: 'changed_mind',
          refund_method: 'cash',
          lines: [{ sale_line_id: lineFor(three).id, quantity: 1, condition: 'resellable' }],
        },
      });
      assert.ok(again.status >= 400, 'the second attempt is refused, not duplicated');
    });

    await ctx.test('a voided invoice has nothing to return', async () => {
      const doomed = await sell([{ key: 1, variant_id: one.variant.id, quantity: 1 }], 100);
      await ok(`/api/sales/${doomed.id}/void`, { method: 'POST', body: { reason: 'test' } });
      const doomedLines = (await ok(`/api/sales/${doomed.id}`)).lines;
      const res = await call('/api/returns', {
        method: 'POST',
        body: {
          return_type: 'with_receipt',
          sale_id: doomed.id,
          reason_code: 'other',
          refund_method: 'cash',
          lines: [{ sale_line_id: doomedLines[0].id, quantity: 1, condition: 'resellable' }],
        },
      });
      assert.ok(res.status >= 400);
      assert.equal(res.data.error.details.rule, 'return_void');
    });

    await ctx.test('a damaged return refunds the money and does NOT restock', async () => {
      const item = await product('Return Damaged', 200);
      const order = await sell([{ key: 1, variant_id: item.variant.id, quantity: 1 }], 200);
      const orderLines = (await ok(`/api/sales/${order.id}`)).lines;
      const shelf = await onHand(item.variant.id);

      const refund = await ok('/api/returns', {
        method: 'POST',
        body: {
          return_type: 'with_receipt',
          sale_id: order.id,
          reason_code: 'defective',
          refund_method: 'cash',
          lines: [{ sale_line_id: orderLines[0].id, quantity: 1, condition: 'damaged' }],
        },
      });
      assert.equal(refund.total_amount, 200, 'the customer is made whole');
      assert.equal(await onHand(item.variant.id), shelf,
        'a broken bottle is refunded and written off, never put back on the shelf');
    });
  });

  // ==================================================== 6. EXCHANGES

  await t.test('exchange: dearer, cheaper, same price, and what it refuses', async (ctx) => {
    const cheap = await product('Exchange Cheap', 500);
    const mid = await product('Exchange Mid', 800);
    const dear = await product('Exchange Dear', 1200);
    const same = await product('Exchange Same', 800);

    const firstLine = async (saleId) => (await ok(`/api/sales/${saleId}`)).lines[0];

    await ctx.test('for something dearer: the customer pays the difference', async () => {
      const sale = await sell([{ key: 1, variant_id: mid.variant.id, quantity: 1 }], 800);
      const line = await firstLine(sale.id);
      const midBefore = await onHand(mid.variant.id);
      const dearBefore = await onHand(dear.variant.id);

      const exchange = await ok('/api/exchanges', {
        method: 'POST',
        body: {
          sale_id: sale.id,
          lines: [{ sale_line_id: line.id, quantity: 1, condition: 'resellable' }],
          replacements: [{ variant_id: dear.variant.id, quantity: 1 }],
          settlement_method: 'cash',
        },
      });

      assert.equal(exchange.credit_amount, 800);
      assert.equal(exchange.replacement_amount, 1200);
      assert.equal(exchange.difference_amount, 400, 'positive: money came in');

      assert.equal(await onHand(mid.variant.id), midBefore + 1, 'what came back is on the shelf');
      assert.equal(await onHand(dear.variant.id), dearBefore - 1, 'what went out has left it');

      // The new invoice is settled in full, and the CREDIT is a payment on it
      // rather than a discount off it — the shop sold 1,200 of goods.
      assert.equal(exchange.replacement.total_amount, 1200);
      assert.equal(exchange.replacement.paid_amount, 1200);
      assert.equal(exchange.replacement.payment_status, 'paid');
      const payments = await getDb()
        .prepare('SELECT amount, method FROM sale_payments WHERE sale_id = ? ORDER BY id')
        .all(exchange.new_sale_id);
      assert.deepEqual(payments.map((p) => `${p.method}:${p.amount}`),
        ['exchange_credit:800', 'cash:400']);

      // The original invoice is untouched history.
      const original = await ok(`/api/sales/${sale.id}`);
      assert.equal(original.status, 'completed');
      assert.equal(original.total_amount, 800);
      assert.equal(original.return_state, 'full');
    });

    await ctx.test('for something cheaper: the shop hands the difference back', async () => {
      const sale = await sell([{ key: 1, variant_id: mid.variant.id, quantity: 1 }], 800);
      const line = await firstLine(sale.id);

      const exchange = await ok('/api/exchanges', {
        method: 'POST',
        body: {
          sale_id: sale.id,
          lines: [{ sale_line_id: line.id, quantity: 1, condition: 'resellable' }],
          replacements: [{ variant_id: cheap.variant.id, quantity: 1 }],
          settlement_method: 'cash',
        },
      });
      assert.equal(exchange.difference_amount, -300, 'negative: money went out');
      assert.equal(exchange.replacement.total_amount, 500);
      assert.equal(exchange.replacement.paid_amount, 500);

      /*
       * The 300 handed back is NOT a payment row against a 500 invoice — the
       * payments behind that invoice must sum to what it says was paid, or the
       * first person to reconcile the two is right to think something broke.
       * It lives on the exchange, which is where the screen shows it.
       */
      const payments = await getDb()
        .prepare('SELECT amount, method FROM sale_payments WHERE sale_id = ?')
        .all(exchange.new_sale_id);
      assert.equal(payments.reduce((sum, p) => sum + p.amount, 0), 500);
      assert.equal(exchange.settlement_method, 'cash');
    });

    await ctx.test('for the same price: nothing crosses the counter', async () => {
      const sale = await sell([{ key: 1, variant_id: mid.variant.id, quantity: 1 }], 800);
      const line = await firstLine(sale.id);
      const exchange = await ok('/api/exchanges', {
        method: 'POST',
        body: {
          sale_id: sale.id,
          lines: [{ sale_line_id: line.id, quantity: 1, condition: 'resellable' }],
          replacements: [{ variant_id: same.variant.id, quantity: 1 }],
        },
      });
      assert.equal(exchange.difference_amount, 0);
      assert.equal(exchange.replacement.paid_amount, 800);
      assert.equal(exchange.replacement.payment_status, 'paid',
        'settled in full by the credit alone — nothing outstanding');
    });

    await ctx.test('several pieces at once, both ways', async () => {
      const sale = await sell([{ key: 1, variant_id: mid.variant.id, quantity: 2 }], 1600);
      const line = await firstLine(sale.id);
      const exchange = await ok('/api/exchanges', {
        method: 'POST',
        body: {
          sale_id: sale.id,
          lines: [{ sale_line_id: line.id, quantity: 2, condition: 'resellable' }],
          replacements: [
            { variant_id: cheap.variant.id, quantity: 2 },
            { variant_id: same.variant.id, quantity: 1 },
          ],
        },
      });
      assert.equal(exchange.credit_amount, 1600);
      assert.equal(exchange.replacement_amount, 1800, '500 + 500 + 800');
      assert.equal(exchange.difference_amount, 200);
    });


    await ctx.test('ONE product off a two-product invoice — the other is untouched', async () => {
      /*
       * The case the shop's owner asked about, holding a real invoice: two
       * pieces on it, the customer wants to swap ONE, and the other must stay
       * bought. Nothing about the second line may move — not its quantity, not
       * its money, not its stock — and the invoice must read "partly returned"
       * rather than returned.
       */
      const keep = await product('Exchange Keep', 200);
      const swap = await product('Exchange Swap', 200);
      const sale = await sell([
        { key: 1, variant_id: keep.variant.id, quantity: 1 },
        { key: 2, variant_id: swap.variant.id, quantity: 1 },
      ], 400);

      const lines = (await ok(`/api/sales/${sale.id}`)).lines;
      const swapLine = lines.find((line) => line.variant_id === swap.variant.id);
      const keepLine = lines.find((line) => line.variant_id === keep.variant.id);

      const keepShelf = await onHand(keep.variant.id);
      const swapShelf = await onHand(swap.variant.id);
      const dearShelf = await onHand(dear.variant.id);

      const exchange = await ok('/api/exchanges', {
        method: 'POST',
        body: {
          sale_id: sale.id,
          // Only the one line, and only one of it.
          lines: [{ sale_line_id: swapLine.id, quantity: 1, condition: 'resellable' }],
          replacements: [{ variant_id: dear.variant.id, quantity: 1 }],
          settlement_method: 'cash',
        },
      });

      assert.equal(exchange.credit_amount, 200,
        'the credit is that ONE line, not the invoice');
      assert.equal(exchange.difference_amount, 1000, '1,200 replacement against 200 of credit');

      const after = await ok(`/api/sales/${sale.id}`);
      assert.equal(after.return_state, 'partial',
        'the invoice is partly returned — the other product is still bought');
      assert.equal(
        after.lines.find((line) => line.id === keepLine.id).returned_quantity, 0,
        'the line nobody touched has come back zero times',
      );
      assert.equal(
        after.lines.find((line) => line.id === swapLine.id).returned_quantity, 1,
      );

      assert.equal(await onHand(keep.variant.id), keepShelf,
        'the kept product never moved on or off the shelf');
      assert.equal(await onHand(swap.variant.id), swapShelf + 1, 'the swapped one came back');
      assert.equal(await onHand(dear.variant.id), dearShelf - 1, 'the replacement went out');

      // And the customer can still return the other one later, on its own.
      const later = await ok('/api/returns', {
        method: 'POST',
        body: {
          return_type: 'with_receipt',
          sale_id: sale.id,
          reason_code: 'changed_mind',
          refund_method: 'cash',
          lines: [{ sale_line_id: keepLine.id, quantity: 1, condition: 'resellable' }],
        },
      });
      assert.equal(later.total_amount, 200, 'the rest of the invoice is still live and returnable');
      assert.equal((await ok(`/api/sales/${sale.id}`)).return_state, 'full');
    });

    await ctx.test('the paper trail joins all three documents', async () => {
      const sale = await sell([{ key: 1, variant_id: mid.variant.id, quantity: 1 }], 800);
      const line = await firstLine(sale.id);
      const exchange = await ok('/api/exchanges', {
        method: 'POST',
        body: {
          sale_id: sale.id,
          lines: [{ sale_line_id: line.id, quantity: 1, condition: 'resellable' }],
          replacements: [{ variant_id: same.variant.id, quantity: 1 }],
        },
      });

      assert.match(exchange.exchange_no, /^EXC-/);
      assert.equal(exchange.original.id, sale.id);
      assert.equal(exchange.return.sale_id, sale.id);
      assert.equal(exchange.replacement.id, exchange.new_sale_id);

      // And it is reachable from the invoice, which is the question a person
      // actually arrives with: "what happened to this one?"
      const original = await ok(`/api/sales/${sale.id}`);
      assert.ok(original.exchanges.some((row) => row.exchange_no === exchange.exchange_no));

      // The return behind it issued no voucher: that credit was spent here.
      assert.equal(exchange.return.refund_method, 'store_credit');
      assert.equal(exchange.return.store_credit_code, null,
        'a voucher would be a second copy of the same money');
    });

    await ctx.test('exchanging the same line twice is refused', async () => {
      const sale = await sell([{ key: 1, variant_id: mid.variant.id, quantity: 1 }], 800);
      const line = await firstLine(sale.id);
      const body = {
        sale_id: sale.id,
        lines: [{ sale_line_id: line.id, quantity: 1, condition: 'resellable' }],
        replacements: [{ variant_id: same.variant.id, quantity: 1 }],
      };
      await ok('/api/exchanges', { method: 'POST', body });
      const again = await call('/api/exchanges', { method: 'POST', body });
      assert.ok(again.status >= 400);
      assert.equal(again.data.error.details.rule, 'return_all_done');
    });

    await ctx.test('nothing coming back, or nothing going out, is not an exchange', async () => {
      const sale = await sell([{ key: 1, variant_id: mid.variant.id, quantity: 1 }], 800);
      const line = await firstLine(sale.id);
      assert.equal((await call('/api/exchanges', {
        method: 'POST',
        body: { sale_id: sale.id, lines: [], replacements: [{ variant_id: same.variant.id, quantity: 1 }] },
      })).status, 422);
      assert.equal((await call('/api/exchanges', {
        method: 'POST',
        body: {
          sale_id: sale.id,
          lines: [{ sale_line_id: line.id, quantity: 1 }],
          replacements: [],
        },
      })).status, 422);
    });

    await ctx.test('more than was bought cannot be exchanged either', async () => {
      const sale = await sell([{ key: 1, variant_id: mid.variant.id, quantity: 1 }], 800);
      const line = await firstLine(sale.id);
      const res = await call('/api/exchanges', {
        method: 'POST',
        body: {
          sale_id: sale.id,
          lines: [{ sale_line_id: line.id, quantity: 4, condition: 'resellable' }],
          replacements: [{ variant_id: same.variant.id, quantity: 1 }],
        },
      });
      assert.ok(res.status >= 400);
      assert.equal(res.data.error.details.rule, 'return_too_many');
    });

    await ctx.test('a replacement the shop does not have rolls the whole thing back', async () => {
      const scarce = await product('Exchange Scarce', 300, 1);
      const sale = await sell([{ key: 1, variant_id: mid.variant.id, quantity: 1 }], 800);
      const line = await firstLine(sale.id);
      const shelf = await onHand(mid.variant.id);

      const res = await call('/api/exchanges', {
        method: 'POST',
        body: {
          sale_id: sale.id,
          lines: [{ sale_line_id: line.id, quantity: 1, condition: 'resellable' }],
          replacements: [{ variant_id: scarce.variant.id, quantity: 99 }],
        },
      });
      assert.ok(res.status >= 400, 'no stock, no exchange');

      /*
       * And nothing half-happened. This is the case the single transaction
       * exists for: without it the customer's bottle would be back on the shelf,
       * their money would be credited, and they would be standing at the counter
       * holding nothing.
       */
      assert.equal(await onHand(mid.variant.id), shelf, 'the returned piece was not restocked');
      const after = await ok(`/api/sales/${sale.id}`);
      assert.equal(after.return_state, 'none', 'the invoice is untouched');
      assert.equal(after.lines[0].returned_quantity, 0);
    });

    await ctx.test('an exchange against a cancelled invoice is refused', async () => {
      const sale = await sell([{ key: 1, variant_id: mid.variant.id, quantity: 1 }], 800);
      const line = await firstLine(sale.id);
      await ok(`/api/sales/${sale.id}/void`, { method: 'POST', body: { reason: 'test' } });
      const res = await call('/api/exchanges', {
        method: 'POST',
        body: {
          sale_id: sale.id,
          lines: [{ sale_line_id: line.id, quantity: 1, condition: 'resellable' }],
          replacements: [{ variant_id: same.variant.id, quantity: 1 }],
        },
      });
      assert.ok(res.status >= 400);
      assert.ok(['exchange_void', 'return_void'].includes(res.data.error.details.rule));
    });

    await ctx.test('the recycle bin will not delete half an exchange', async () => {
      const sale = await sell([{ key: 1, variant_id: mid.variant.id, quantity: 1 }], 800);
      const line = await firstLine(sale.id);
      const exchange = await ok('/api/exchanges', {
        method: 'POST',
        body: {
          sale_id: sale.id,
          lines: [{ sale_line_id: line.id, quantity: 1, condition: 'resellable' }],
          replacements: [{ variant_id: same.variant.id, quantity: 1 }],
        },
      });

      /*
       * Deleting the return alone would un-do the credit while the replacement
       * invoice still stood, paid for by credit that no longer existed. The bin
       * refuses and names the exchange, so the person can go and look at what
       * they are actually trying to undo.
       */
      const preview = await ok(`/api/trash/preview/sales_return/${exchange.return_id}`);
      assert.equal(preview.ok, false);
      const blocker = preview.blockers.find((entry) => entry.code === 'part_of_exchange');
      assert.ok(blocker, 'the refusal exists');
      assert.match(blocker.en, /EXC-/);
      assert.match(blocker.ar, /EXC-/);

      const refused = await call('/api/trash', {
        method: 'POST',
        body: { entityType: 'sales_return', entityId: exchange.return_id },
      });
      assert.ok(refused.status >= 400, 'and it is enforced, not merely displayed');
    });

  });


  // ========================================== 10. INVENTORY & MONEY INTEGRITY

  await t.test('the books add up after all of that', async () => {
    /*
     * Two invariants, checked over everything this file did rather than over
     * one document:
     *
     *   · Every invoice is paid for by exactly what its payments say. An
     *     exchange settles part of an invoice with credit, and the moment that
     *     stops summing, the shop's takings are wrong and nobody finds out from
     *     a screen.
     *   · No variant is holding negative stock. Returns put things back and
     *     exchanges take things out in the same breath; a sign error in either
     *     direction lands here.
     */
    const unpaid = await getDb().prepare(`
      SELECT s.invoice_no, s.paid_amount,
             (SELECT COALESCE(SUM(p.amount), 0) FROM sale_payments p WHERE p.sale_id = s.id) AS paid_rows
      FROM sales s
      WHERE s.status = 'completed'
    `).all();
    for (const row of unpaid) {
      assert.ok(Math.abs(row.paid_amount - row.paid_rows) < 0.01,
        `${row.invoice_no}: header says ${row.paid_amount}, payments say ${row.paid_rows}`);
    }

    const negative = await getDb()
      .prepare('SELECT COUNT(*) AS n FROM stock_levels WHERE quantity < 0').get();
    assert.equal(Number(negative.n), 0, 'nothing is holding negative stock');

    // Every exchange still points at three documents that exist.
    const orphans = await getDb().prepare(`
      SELECT COUNT(*) AS n FROM exchanges e
       WHERE NOT EXISTS (SELECT 1 FROM sales s WHERE s.id = e.sale_id)
          OR NOT EXISTS (SELECT 1 FROM sales s2 WHERE s2.id = e.new_sale_id)
          OR NOT EXISTS (SELECT 1 FROM sales_returns r WHERE r.id = e.return_id)
    `).get();
    assert.equal(Number(orphans.n), 0);
  });
});
