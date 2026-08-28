/**
 * End-to-end smoke test against a running server.
 *   node --test tests/
 * Exercises the full commercial cycle: catalogue -> purchase -> receive ->
 * sell (with a promotion) -> return -> report -> audit.
 */
import './single-shop.js'; // must be first — see that file
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import {
  initDb, applySchema, closeDb, supportsFileBackup, getDb,
} from '../src/infrastructure/database/connection.js';
import { runMigrations } from '../src/infrastructure/database/migrations/index.js';



/**
 * By default the suite starts the app itself on an ephemeral port, so
 * `npm test` needs nothing but a seeded database. Point MM_TEST_URL at a
 * running instance to test that one instead.
 */
let base = process.env.MM_TEST_URL || '';
let server = null;
let cookie = '';

before(async () => {
  if (base) return;
  /*
   * Open, shaped and migrated before the first request - exactly as in start().
   *
   * This used to be `initDb()` alone, which was true of the boot sequence when
   * it was written and stopped being true the moment a migration added a
   * column. The suite runs against the shared development database, so a
   * database created before that migration stayed created before it: every
   * purchase test failed with "no column named discount_type" against code that
   * was perfectly correct. A test bootstrap that does less than the real one is
   * a test bootstrap that fails for reasons the product does not have.
   */
  await initDb();
  await applySchema();
  await runMigrations();
  const app = createApp();
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
  await closeDb();
});

/**
 * One request, with the header a real client always sends.
 *
 * `Idempotency-Key` is minted per submission by all three front ends (see
 * public/js/core/api.js). A client that sends none is fingerprinted by CONTENT
 * for ten seconds instead — which is correct behaviour and exactly wrong for a
 * walkthrough that rings up two identical one-item sales half a second apart on
 * purpose: the server would rightly call the second one a double-click and
 * replay the first. A fresh key per call is what a till does, so it is what
 * this does. See src/api/middleware/idempotency.js.
 */
let requestNo = 0;
async function api(path, { method = 'GET', body } = {}) {
  requestNo += 1;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `smoke-${process.pid}-${Date.now()}-${requestNo}`,
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const err = new Error(data?.error?.message || `HTTP ${res.status} on ${path}`);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

const state = {};

test('health check', async () => {
  const health = await api('/api/health');
  assert.equal(health.status, 'ok');
});

test('login as administrator', async () => {
  const result = await api('/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'admin123' },
  });
  assert.equal(result.user.username, 'admin');
  assert.ok(result.user.permissions.includes('sales.create'));
});

test('rejects a bad password', async () => {
  const saved = cookie;
  cookie = '';
  await assert.rejects(
    () => api('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'nope' } }),
    (e) => e.status === 401,
  );
  cookie = saved;
});

test('creates a product with a size x colour variant matrix', async () => {
  const attributes = await api('/api/attributes/with-values');
  const size = attributes.rows.find((a) => a.code === 'SIZE');
  const colour = attributes.rows.find((a) => a.code === 'COLOR');
  const sizes = size.values.filter((v) => ['S', 'M'].includes(v.code));
  const colours = colour.values.filter((v) => ['BLK', 'GLD'].includes(v.code));

  const variants = [];
  for (const s of sizes) {
    for (const c of colours) {
      variants.push({
        cost_price: 100,
        selling_price: 250 + (s.code === 'M' ? 20 : 0),
        wholesale_price: 200,
        reorder_level: 4,
        reorder_quantity: 25,
        options: [
          { attribute_id: size.id, attribute_value_id: s.id },
          { attribute_id: colour.id, attribute_value_id: c.id },
        ],
      });
    }
  }

  const product = await api('/api/products', {
    method: 'POST',
    body: {
      sku_prefix: `TST-${Date.now().toString().slice(-6)}`,
      name_en: 'Test Chain Bracelet',
      name_ar: 'إسورة اختبار',
      tax_rate: 14,
      base_cost: 100,
      base_price: 250,
      attribute_ids: [size.id, colour.id],
      variants,
    },
  });
  assert.equal(product.variants.length, 4);
  assert.ok(product.variants.every((v) => v.sku.startsWith(product.sku_prefix)));
  // Per-combination pricing is preserved.
  const medium = product.variants.filter((v) => v.variant_label.startsWith('Medium'));
  assert.ok(medium.every((v) => v.selling_price === 270));
  state.product = product;
  state.variant = product.variants[0];
});

test('scans a variant by its QR/barcode payload', async () => {
  const found = await api(`/api/products/scan/${encodeURIComponent(state.variant.barcode)}`);
  assert.equal(found.variant_id, state.variant.id);
});

test('product details overview assembles stock, performance and history', async () => {
  const overview = await api(`/api/products/${state.product.id}/overview`);
  assert.equal(overview.product.id, state.product.id);
  assert.equal(overview.variants.length, 4);
  assert.equal(overview.totals.variantCount, 4);
  // Every variant carries its own live stock, valuation and margin.
  for (const variant of overview.variants) {
    assert.ok('quantity' in variant && 'stock_value' in variant && 'margin_percent' in variant);
  }
  assert.ok(Array.isArray(overview.sales));
  assert.ok(Array.isArray(overview.purchases));
  assert.ok(Array.isArray(overview.movements));
  assert.ok(Array.isArray(overview.returns));
  assert.equal(overview.performance.windowDays, 90);
});

test('purchase order: create, approve, receive — stock and cost update', async () => {
  const suppliers = await api('/api/suppliers/options');
  const po = await api('/api/purchases', {
    method: 'POST',
    body: {
      supplier_id: suppliers.rows[0].id,
      order_date: new Date().toISOString().slice(0, 10),
      lines: state.product.variants.map((v) => ({
        variant_id: v.id, quantity_ordered: 10, unit_cost: 110, tax_rate: 14,
      })),
    },
  });
  assert.equal(po.status, 'draft');
  assert.equal(po.lines.length, 4);

  await api(`/api/purchases/${po.id}/approve`, { method: 'POST' });
  const received = await api(`/api/purchases/${po.id}/receive`, {
    method: 'POST',
    body: { receipts: po.lines.map((l) => ({ line_id: l.id, quantity: 10 })) },
  });
  assert.equal(received.status, 'received');

  const details = await api(`/api/products/variants/${state.variant.id}`);
  assert.equal(details.stock[0].quantity, 10);
  state.poId = po.id;
});

test('a brand carries its own logo', async (ctx) => {
  /**
   * The storefront's brands rail shows a picture where the shop has one and a
   * letter where it does not, and until this existed no shop had one: the only
   * way to fill `logo_url` was to type a link to somebody else\'s website into a
   * text field. The bytes now live in `web_assets` under a slot named for the
   * brand — the same table, service and audit trail as the banner and the shop\'s
   * own logo, rather than a second way to store a picture.
   */
  // A 1×1 transparent PNG. The point is the round trip, not the picture.
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const brands = await api('/api/brands?all=1');
  const brand = brands.rows[0];
  assert.ok(brand, 'the seed has no brands to hang a logo on');

  await ctx.test('it starts with none, and the list says so', async () => {
    const state = await api(`/api/brands/${brand.id}/logo`);
    assert.equal(state.hasImage, false);
    const listed = await api('/api/brands?all=1');
    assert.equal(listed.rows.find((row) => row.id === brand.id).has_logo, 0);
  });

  await ctx.test('it is stored as the type it was sent as', async () => {
    const saved = await api(`/api/brands/${brand.id}/logo`, { method: 'PUT', body: { dataUrl: png } });
    assert.equal(saved.hasImage, true);
    // A logo re-encoded to JPEG would arrive with a white rectangle behind it
    // and wear that rectangle on every dark band of the site.
    assert.equal(saved.contentType, 'image/png');
  });

  await ctx.test('the list can then be scanned for the ones still missing one', async () => {
    const listed = await api('/api/brands?all=1');
    assert.equal(listed.rows.find((row) => row.id === brand.id).has_logo, 1);
  });

  await ctx.test('and the public storefront serves it without a login', async () => {
    const res = await fetch(`${base}/api/shop/brands/${brand.id}/logo`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    // Not `immutable`: the address has no id in it, so a replaced logo must not
    // be answered from a year-old cache.
    assert.match(res.headers.get('cache-control') || '', /max-age=300/);
  });

  await ctx.test('an id that is not a brand gets a 404, not a slot', async () => {
    await assert.rejects(
      () => api('/api/brands/999999/logo', { method: 'PUT', body: { dataUrl: png } }),
      (error) => error.status === 404,
    );
  });

  await ctx.test('and removing it puts the letter back', async () => {
    const cleared = await api(`/api/brands/${brand.id}/logo`, { method: 'DELETE' });
    assert.equal(cleared.hasImage, false);
  });
});

test('a purchase order discount is a rate, and the money follows the lines', async (ctx) => {
  /**
   * The supplier says five percent; nobody should be doing his arithmetic by
   * hand, and nobody should have to do it AGAIN because a line changed. The
   * rate is what is typed and stored; `discount_amount` is still the money and
   * is still what every total, report and printed order reads.
   */
  const suppliers = await api('/api/suppliers/options');
  const body = (percent) => ({
    supplier_id: suppliers.rows[0].id,
    order_date: new Date().toISOString().slice(0, 10),
    discount_percent: percent,
    lines: [{
      variant_id: state.variant.id, quantity_ordered: 10, unit_cost: 100, tax_rate: 0,
    }],
  });

  let created;
  await ctx.test('the amount is worked out from the subtotal', async () => {
    created = await api('/api/purchases', { method: 'POST', body: body(5) });
    assert.equal(created.subtotal, 1000);
    assert.equal(created.discount_percent, 5);
    assert.equal(created.discount_amount, 50);
    assert.equal(created.total_amount, 950);
  });

  await ctx.test('and it follows the lines when they change', async () => {
    const changed = await api(`/api/purchases/${created.id}`, {
      method: 'PUT',
      body: {
        ...body(5),
        lines: [{
          variant_id: state.variant.id, quantity_ordered: 20, unit_cost: 100, tax_rate: 0,
        }],
      },
    });
    // The whole reason for the change: nothing was retyped and the discount is
    // still five percent of what the order actually costs.
    assert.equal(changed.subtotal, 2000);
    assert.equal(changed.discount_amount, 100);
    assert.equal(changed.total_amount, 1900);
  });

  await ctx.test('an order sent the old way keeps its amount untouched', async () => {
    // An offline till queued this before the shop updated. Its total must not
    // move because somebody deployed.
    const legacy = await api('/api/purchases', {
      method: 'POST',
      body: {
        supplier_id: suppliers.rows[0].id,
        order_date: new Date().toISOString().slice(0, 10),
        discount_amount: 37.5,
        lines: [{
          variant_id: state.variant.id, quantity_ordered: 10, unit_cost: 100, tax_rate: 0,
        }],
      },
    });
    assert.equal(legacy.discount_amount, 37.5);
    assert.equal(legacy.discount_percent, 0);
    assert.equal(legacy.total_amount, 962.5);
  });

  await ctx.test('a rate outside 0–100 is refused', async () => {
    await assert.rejects(
      () => api('/api/purchases', { method: 'POST', body: body(140) }),
      // The form validator refuses it before the service ever sees it, which is
      // the right place for it to be refused.
      (error) => error.status === 422 || error.status === 400,
    );
  });
});

test('rejects receiving more than was ordered', async () => {
  const po = await api(`/api/purchases/${state.poId}`);
  await assert.rejects(
    () => api(`/api/purchases/${po.id}/receive`, {
      method: 'POST',
      body: { receipts: [{ line_id: po.lines[0].id, quantity: 5 }] },
    }),
    (e) => e.status === 400,
  );
});

test('blocks a sale that exceeds available stock', async () => {
  await assert.rejects(
    () => api('/api/sales', {
      method: 'POST',
      body: {
        lines: [{ variant_id: state.variant.id, quantity: 999 }],
        payment_method: 'cash',
        paid_amount: 1,
      },
    }),
    (e) => e.status === 400,
  );
});

test('quotes a basket with a percentage promotion', async () => {
  const customers = await api('/api/customers/search?q=Sara');
  state.customer = customers.rows[0];
  state.promoCode = `TEST10-${Date.now().toString().slice(-6)}`;

  await api('/api/promotions', {
    method: 'POST',
    body: {
      code: state.promoCode,
      name_en: 'Smoke-test 10%',
      kind: 'discount',
      discount_type: 'percentage',
      value: 10,
      scope: 'order',
      min_order_amount: 100,
    },
  });

  // A code below its minimum basket value must be refused.
  await assert.rejects(
    () => api('/api/sales/quote', {
      method: 'POST',
      body: {
        lines: [{ key: 1, variant_id: state.variant.id, quantity: 2 }],
        promotion_code: 'NO-SUCH-CODE',
      },
    }),
    (e) => e.status === 404,
  );

  const quote = await api('/api/sales/quote', {
    method: 'POST',
    body: {
      customer_id: state.customer.id,
      lines: [{ key: 1, variant_id: state.variant.id, quantity: 2 }],
      promotion_code: state.promoCode,
    },
  });
  assert.equal(quote.promotion.code, state.promoCode);
  assert.ok(quote.promotionDiscount > 0);
  // Tax must be charged on the discounted net, not the gross.
  const expectedNet = 250 * 2 - quote.promotionDiscount;
  assert.ok(Math.abs(quote.taxAmount - expectedNet * 0.14) < 0.05);
  state.quote = quote;
});

test('checkout issues stock, records payment and redeems the code', async () => {
  const customer = state.customer;
  const sale = await api('/api/sales', {
    method: 'POST',
    body: {
      customer_id: customer.id,
      lines: [{ key: 1, variant_id: state.variant.id, quantity: 2 }],
      promotion_code: state.promoCode,
      payment_method: 'cash',
      paid_amount: 1000,
    },
  });
  assert.equal(sale.status, 'completed');
  assert.equal(sale.payment_status, 'paid');
  assert.equal(sale.promotion_code, state.promoCode);
  assert.ok(sale.total_amount > 0);
  assert.equal(sale.lines.length, 1);

  const details = await api(`/api/products/variants/${state.variant.id}`);
  assert.equal(details.stock[0].quantity, 8);
  state.sale = sale;
});

test('return lookup finds the invoice by number and by scanned receipt QR', async () => {
  const byNumber = await api(`/api/returns/lookup?reference=${state.sale.invoice_no}`);
  assert.equal(byNumber.sale.invoice_no, state.sale.invoice_no);
  assert.equal(byNumber.lines.length, 1);
  // The receipt QR encodes INV:<number> — scanning it must work identically.
  const byQr = await api(`/api/returns/lookup?reference=${encodeURIComponent(`INV:${state.sale.invoice_no}`)}`);
  assert.equal(byQr.sale.id, byNumber.sale.id);
  // The refund offered is what was actually paid, net of the promotion.
  const line = byNumber.lines[0];
  assert.ok(Math.abs(line.refund_per_unit * line.sold_quantity - state.sale.total_amount) < 0.05);
  state.returnable = byNumber;
});

test('resellable return restocks, refunds the discounted price and reverses points', async () => {
  const customerBefore = (await api(`/api/customers/${state.customer.id}`));
  const line = state.returnable.lines[0];

  const record = await api('/api/returns', {
    method: 'POST',
    body: {
      return_type: 'with_receipt',
      sale_id: state.sale.id,
      reason_code: 'wrong_size',
      refund_method: 'cash',
      lines: [{ sale_line_id: line.sale_line_id, quantity: 1, condition: 'resellable' }],
    },
  });

  assert.equal(record.return_type, 'with_receipt');
  assert.equal(record.items_restocked, 1);
  assert.equal(record.items_written_off, 0);
  // Refund equals one unit of what was paid, not the list price.
  assert.ok(Math.abs(record.total_amount - line.refund_per_unit) < 0.05);

  const details = await api(`/api/products/variants/${state.variant.id}`);
  assert.equal(details.stock[0].quantity, 9, 'good stock goes back on the shelf');

  const customerAfter = await api(`/api/customers/${state.customer.id}`);
  assert.ok(customerAfter.loyalty_points < customerBefore.loyalty_points,
    'points earned on the returned value are taken back');
  state.firstReturn = record;
});

test('damaged return comes back in and is written off, so the loss is visible', async () => {
  const line = state.returnable.lines[0];
  const record = await api('/api/returns', {
    method: 'POST',
    body: {
      return_type: 'with_receipt',
      sale_id: state.sale.id,
      reason_code: 'defective',
      refund_method: 'cash',
      lines: [{ sale_line_id: line.sale_line_id, quantity: 1, condition: 'damaged' }],
    },
  });
  assert.equal(record.items_written_off, 1);
  assert.equal(record.items_restocked, 0);

  const details = await api(`/api/products/variants/${state.variant.id}`);
  assert.equal(details.stock[0].quantity, 9, 'a damaged return must not inflate sellable stock');

  const ledger = await api('/api/inventory/movements?pageSize=200');
  const forThisReturn = ledger.rows.filter((m) => m.reference_no === record.return_no);
  assert.equal(forThisReturn.length, 2, 'received then written off — both are on the ledger');
  assert.ok(forThisReturn.some((m) => m.movement_type === 'sale_return' && m.quantity > 0));
  assert.ok(forThisReturn.some((m) => m.movement_type === 'write_off' && m.quantity < 0));
});

test('a restocking fee applies to a change of mind but never to our own fault', async () => {
  const makeSale = async () => {
    const sale = await api('/api/sales', {
      method: 'POST',
      body: {
        lines: [{ key: 1, variant_id: state.variant.id, quantity: 1 }],
        payment_method: 'cash',
        paid_amount: 1000,
      },
    });
    const lookup = await api(`/api/returns/lookup?reference=${sale.invoice_no}`);
    return { sale, line: lookup.lines[0] };
  };

  const changedMind = await makeSale();
  const withFee = await api('/api/returns', {
    method: 'POST',
    body: {
      return_type: 'with_receipt',
      sale_id: changedMind.sale.id,
      reason_code: 'changed_mind',
      refund_method: 'cash',
      restocking_fee: 20,
      lines: [{ sale_line_id: changedMind.line.sale_line_id, quantity: 1, condition: 'resellable' }],
    },
  });
  assert.equal(withFee.restocking_fee, 20);
  assert.ok(Math.abs(withFee.total_amount - (changedMind.line.refund_per_unit - 20)) < 0.05);

  const ourFault = await makeSale();
  const noFee = await api('/api/returns', {
    method: 'POST',
    body: {
      return_type: 'with_receipt',
      sale_id: ourFault.sale.id,
      reason_code: 'defective',
      refund_method: 'cash',
      restocking_fee: 50,
      lines: [{ sale_line_id: ourFault.line.sale_line_id, quantity: 1, condition: 'resellable' }],
    },
  });
  assert.equal(noFee.restocking_fee, 0, 'a faulty item never carries a fee');
});

test('cannot return more than was sold', async () => {
  const line = state.returnable.lines[0];
  await assert.rejects(
    () => api('/api/returns', {
      method: 'POST',
      body: {
        return_type: 'with_receipt',
        sale_id: state.sale.id,
        reason_code: 'other',
        lines: [{ sale_line_id: line.sale_line_id, quantity: 99, condition: 'resellable' }],
      },
    }),
    (e) => e.status === 400,
  );
});

test('store-credit refund issues a usable voucher', async () => {
  const sale = await api('/api/sales', {
    method: 'POST',
    body: {
      lines: [{ key: 1, variant_id: state.variant.id, quantity: 1 }],
      payment_method: 'cash',
      paid_amount: 1000,
    },
  });
  const lookup = await api(`/api/returns/lookup?reference=${sale.invoice_no}`);
  const record = await api('/api/returns', {
    method: 'POST',
    body: {
      return_type: 'with_receipt',
      sale_id: sale.id,
      reason_code: 'changed_mind',
      refund_method: 'store_credit',
      lines: [{ sale_line_id: lookup.lines[0].sale_line_id, quantity: 1, condition: 'resellable' }],
    },
  });
  assert.ok(record.store_credit_code, 'a voucher code is issued');

  const voucher = await api(`/api/promotions/validate/${record.store_credit_code}`);
  assert.equal(voucher.valid, true);
  assert.equal(voucher.promotion.kind, 'voucher');
  assert.ok(Math.abs(voucher.promotion.voucher_balance - record.total_amount) < 0.05);
});

test('no-receipt return is refused for a cashier and allowed for a manager', async () => {
  const adminCookie = cookie;
  cookie = '';
  await api('/api/auth/login', { method: 'POST', body: { username: 'cashier', password: 'cashier123' } });
  await assert.rejects(
    () => api('/api/returns', {
      method: 'POST',
      body: {
        return_type: 'no_receipt',
        reason_code: 'other',
        lines: [{ variant_id: state.variant.id, quantity: 1, condition: 'resellable' }],
      },
    }),
    (e) => e.status === 403,
  );
  cookie = adminCookie;

  const record = await api('/api/returns', {
    method: 'POST',
    body: {
      return_type: 'no_receipt',
      reason_code: 'wrong_item',
      lines: [{ variant_id: state.variant.id, quantity: 1, condition: 'resellable' }],
    },
  });
  assert.equal(record.return_type, 'no_receipt');
  // Without proof of payment the refund can only ever be store credit.
  assert.equal(record.refund_method, 'store_credit');
  assert.ok(record.store_credit_code);
});

test('quick stock adjustment corrects a single line', async () => {
  const before = (await api(`/api/products/variants/${state.variant.id}`)).stock[0].quantity;
  await api('/api/inventory/quick-adjust', {
    method: 'POST',
    body: { variantId: state.variant.id, newQuantity: before + 2, reason: 'correction', notes: 'smoke test' },
  });
  const after = (await api(`/api/products/variants/${state.variant.id}`)).stock[0].quantity;
  assert.equal(after, before + 2);
});

test('stock count sheet loads system quantities and posts the difference', async () => {
  // The count sheet is how a real stock take starts: pre-filled with what the
  // system believes, so the clerk only types what they actually counted.
  const sheet = await api('/api/inventory/count-sheet');
  const row = sheet.rows.find((r) => r.variant_id === state.variant.id);
  assert.ok(row, 'the variant appears on the count sheet');
  assert.equal(row.counted_qty, row.system_qty, 'pre-filled with the system quantity');

  const counted = row.system_qty - 2;
  const adjustment = await api('/api/inventory/adjustments', {
    method: 'POST',
    body: {
      reason: 'stock_take',
      lines: [{
        variant_id: row.variant_id,
        system_qty: row.system_qty,
        counted_qty: counted,
        unit_cost: row.unit_cost,
      }],
    },
  });
  await api(`/api/inventory/adjustments/${adjustment.id}/post`, { method: 'POST' });

  const details = await api(`/api/products/variants/${state.variant.id}`);
  assert.equal(details.stock[0].quantity, counted, 'the counted figure wins');
});

test('voiding a sale reverses stock and the promotion usage', async () => {
  const before = await api(`/api/promotions/validate/${state.promoCode}`);
  const sale = await api('/api/sales', {
    method: 'POST',
    body: {
      lines: [{ key: 1, variant_id: state.variant.id, quantity: 1 }],
      payment_method: 'cash',
      paid_amount: 500,
    },
  });
  const afterSale = await api(`/api/products/variants/${state.variant.id}`);
  const soldDown = afterSale.stock[0].quantity;

  await api(`/api/sales/${sale.id}/void`, { method: 'POST', body: { reason: 'Test void' } });
  const afterVoid = await api(`/api/products/variants/${state.variant.id}`);
  assert.equal(afterVoid.stock[0].quantity, soldDown + 1, 'voiding puts the stock back');
  assert.ok(before.promotion);
});

test('product details reflect trading once there is history', async () => {
  const overview = await api(`/api/products/${state.product.id}/overview`);
  assert.ok(overview.performance.units > 0, 'units sold are counted');
  assert.ok(overview.performance.revenue > 0, 'revenue is counted');
  assert.ok(overview.sales.length > 0, 'sales history is populated');
  assert.ok(overview.purchases.length > 0, 'purchase history is populated');
  assert.ok(overview.movements.length > 0, 'the ledger is populated');
  assert.ok(overview.returns.length > 0, 'returns show against the product');
  assert.ok(overview.totals.stockValue >= 0);
});

test('reports run and export as CSV', async () => {
  const catalogue = await api('/api/reports');
  assert.ok(catalogue.rows.length >= 10);
  for (const definition of catalogue.rows) {
    const report = await api(`/api/reports/${definition.key}`);
    assert.ok(Array.isArray(report.rows), `${definition.key} returned rows`);
    assert.ok(report.columns.length > 0);
  }
  const csv = await api('/api/reports/inventory_valuation?format=csv');
  assert.ok(String(csv).includes('SKU'));
});

test('label batch renders data URIs (round 3: defaults to code128, not qr)', async () => {
  const batch = await api('/api/labels/batch', {
    method: 'POST',
    body: { items: [{ variant_id: state.variant.id, copies: 2 }], labelSize: '40x30' },
  });
  assert.equal(batch.labels.length, 2);
  // The shop's scanner is 1D-only, so labels.symbology now defaults to
  // code128 rather than qr — see tests/labels-symbology.test.js for the full
  // coverage of symbology / codeImage / codeAspect and the round-trip-tested
  // encoders in tests/barcode.test.js. `qr` is kept equal to `codeImage` this
  // release so a label sheet mid-deploy that only knows `label.qr` still has
  // something to render.
  assert.equal(batch.labels[0].symbology, 'code128');
  assert.ok(batch.labels[0].codeImage.startsWith('data:image/svg+xml;base64,'));
  assert.equal(batch.labels[0].qr, batch.labels[0].codeImage);
});

test('audit log captured every mutation', async () => {
  const audit = await api('/api/audit?pageSize=200');
  const actions = new Set(audit.rows.map((r) => r.action));
  for (const expected of ['LOGIN', 'CREATE', 'RECEIVE', 'RETURN', 'VOID', 'POST', 'PRINT', 'ADJUST']) {
    assert.ok(actions.has(expected), `audit trail contains ${expected}`);
  }
  const failedLogin = audit.rows.find((r) => r.action === 'LOGIN' && r.status === 'FAILED');
  assert.ok(failedLogin, 'failed sign-in attempts are logged');
});

test('role permissions are enforced', async () => {
  const adminCookie = cookie;
  cookie = '';
  await api('/api/auth/login', { method: 'POST', body: { username: 'cashier', password: 'cashier123' } });
  await assert.rejects(() => api('/api/users'), (e) => e.status === 403);
  await assert.rejects(
    () => api('/api/suppliers', { method: 'POST', body: { name_en: 'Nope' } }),
    (e) => e.status === 403,
  );
  const products = await api('/api/products');
  assert.ok(products.rows.length > 0, 'cashier can still read the catalogue');
  cookie = adminCookie;
});

/**
 * Copying the database FILE means different things per driver: it is a real
 * copy on a shop PC and impossible on a hosted database, where there is no file.
 * The hosted path must refuse loudly rather than hand back a file that does not
 * exist — and its refusal must carry a code, because the screen has to be able
 * to say it in Arabic. Taking the shop's own DATA out is a different act that
 * works on both, and is asserted below.
 */
test('backup can be created and listed', async () => {
  if (!supportsFileBackup()) {
    await assert.rejects(
      () => api('/api/settings/backups', { method: 'POST' }),
      (error) => error.payload?.error?.code === 'FILE_BACKUP_UNAVAILABLE',
      'a hosted database must refuse a file backup with a code the screen can translate',
    );
    const list = await api('/api/settings/backups');
    assert.deepEqual(list.rows, [], 'no local backup files exist on a hosted database');
    return;
  }

  const created = await api('/api/settings/backups', { method: 'POST' });
  assert.ok(created.file.endsWith('.db'));
  const list = await api('/api/settings/backups');
  assert.ok(list.rows.some((b) => b.file === created.file));
  await api(`/api/settings/backups/${created.file}`, { method: 'DELETE' });
});

/**
 * The shop's own copy of its own data, on the build that has no platform at all.
 *
 * Everything else about this feature is exercised in `shop-data-export.test.js`,
 * against a fleet. This one is here because the single-shop build is the case
 * that file cannot reach: no control plane, no tenant, no slug — a shop PC —
 * and the promise on the landing page («بياناتك بتاعتك») is made to that shop
 * as well as to a hosted one.
 */
test('the shop can download a copy of its own data', async () => {
  // This suite runs against the development database, which keeps whatever the
  // last run left in it — and the rate limit below is deliberately remembered
  // in `audit_logs`, so the last run's copy would refuse this one. Clearing the
  // shop's export history is this test's way of starting from "none taken yet".
  await getDb().prepare("DELETE FROM audit_logs WHERE entity_type = 'data_export'").run();

  const status = await api('/api/settings/data-export');
  assert.equal(status.available, true);
  assert.deepEqual(status.redacted, ['users.password_hash']);

  const res = await fetch(`${base}/api/settings/data-export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.match(res.headers.get('content-disposition'), /attachment; filename=".*\.zip"/);

  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(bytes.readUInt32LE(0), 0x04034B50, 'it really is a ZIP');
  const text = bytes.toString('latin1');
  assert.ok(text.includes('README.txt'), 'with the note that explains it');
  assert.ok(text.includes('snapshot/manifest.json'), 'the snapshot');
  assert.ok(/spreadsheets\/.*-ar\.xlsx/.test(text), 'the Arabic workbook');
  assert.ok(/spreadsheets\/.*-en\.xlsx/.test(text), 'and the English one');

  // A second press, straight away, is refused rather than read the shop again.
  const again = await fetch(`${base}/api/settings/data-export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
  });
  assert.equal(again.status, 429);
  assert.equal((await again.json()).error.code, 'EXPORT_RATE_LIMITED');
  assert.ok(again.headers.get('retry-after'));
});

// --------------------------------------------------------------- new in v1.8

test('a product needs no attributes — it gets one variant with the code you scanned', async () => {
  const code = `SIMPLE-${Date.now().toString().slice(-6)}`;
  const created = await api('/api/products', {
    method: 'POST',
    body: {
      sku_prefix: code,
      name_en: 'Plain Keyring',
      base_cost: 40,
      base_price: 90,
      tax_rate: 14,
      attribute_ids: [],
      variants: [],
    },
  });

  assert.equal(created.variants.length, 1, 'exactly one variant is created behind the scenes');
  const [variant] = created.variants;
  assert.equal(variant.sku, code, 'the variant takes the product code as its SKU');
  assert.equal(variant.barcode, code, 'and the same code as its barcode, so it scans');

  // It has to be a real, sellable variant — not a placeholder row.
  const scanned = await api(`/api/products/scan/${encodeURIComponent(code)}`);
  assert.equal(scanned.variant_id, variant.id, 'scanning the code finds it');

  // Saving again must not spawn a second variant or orphan the first.
  const resaved = await api(`/api/products/${created.id}`, {
    method: 'PUT',
    body: {
      sku_prefix: code,
      name_en: 'Plain Keyring',
      base_cost: 40,
      base_price: 95,
      tax_rate: 14,
      attribute_ids: [],
      variants: [],
    },
  });
  assert.equal(resaved.variants.length, 1, 'still one variant after a re-save');
  assert.equal(resaved.variants[0].id, variant.id, 'and it is the same row, so stock survives');
});

test('a locked-out user is let back in by an administrator, never by email', async () => {
  const username = `locked_${Date.now().toString().slice(-6)}`;
  const roles = await api('/api/users/roles');
  const cashierRole = roles.rows.find((r) => r.code === 'cashier');
  await api('/api/users', {
    method: 'POST',
    body: {
      username,
      full_name: 'Locked Out Tester',
      password: 'initial123',
      role_id: cashierRole.id,
    },
  });

  const adminCookie = cookie;

  // The request is unauthenticated by design — the user cannot sign in.
  cookie = '';
  const requested = await api('/api/auth/forgot-password', {
    method: 'POST',
    body: { username, note: 'Cannot sign in at the till' },
  });
  assert.equal(requested.requested, true);

  // An unknown username must look identical, or this becomes a way to
  // discover which staff accounts exist.
  const unknown = await api('/api/auth/forgot-password', {
    method: 'POST',
    body: { username: 'no-such-person' },
  });
  assert.deepEqual(unknown, requested, 'unknown and real usernames answer the same way');

  cookie = adminCookie;
  const pending = await api('/api/users/reset-requests');
  const mine = pending.rows.find((r) => r.username === username);
  assert.ok(mine, 'the request reaches the administrator queue');
  assert.equal(mine.note, 'Cannot sign in at the till');

  const { pending: count } = await api('/api/users/reset-requests/count');
  assert.ok(count >= 1, 'and is counted for the badge');

  const approval = await api(`/api/users/reset-requests/${mine.id}/approve`, { method: 'POST' });
  assert.ok(approval.oneTimePassword, 'approval issues a one-time password');

  // Approving twice must not mint a second password for the same request.
  await assert.rejects(
    () => api(`/api/users/reset-requests/${mine.id}/approve`, { method: 'POST' }),
    (e) => e.status >= 400,
    'an already-handled request cannot be approved again',
  );

  cookie = '';
  const signedIn = await api('/api/auth/login', {
    method: 'POST',
    body: { username, password: approval.oneTimePassword },
  });
  assert.equal(signedIn.user.mustChangePassword, true, 'and forces a change immediately');

  await assert.rejects(
    () => api('/api/auth/login', { method: 'POST', body: { username, password: 'initial123' } }),
    (e) => e.status === 401,
    'the old password is dead',
  );

  cookie = adminCookie;
});

test('a single shop reports no tenant — the platform is not merely disabled, it is absent', async () => {
  // The same endpoint the ERP boots from. On a shop PC it must say "no tenant"
  // rather than fail or invent one, because the front end uses this to decide
  // whether any module is hidden — and a shop with modules missing from its own
  // sidebar would be a very quiet way to break someone's till.
  const session = await api('/api/session');
  assert.equal(session.tenant, null);
});

/* Last on purpose: this one writes a unit off, and the tests above count the shelf. */
test('the wastage screen answers, and its numbers are the ones behind it', async (ctx) => {
  /**
   * الهدر. The money behind this had tests from the day it was written — the
   * profit report, the dashboard, the refusal to write off more than is on the
   * shelf — and the PAGE still answered 500 on the owner's live shop, because
   * the service reached for the method on the wrong repository and nothing
   * asked it for anything. A figure with no door onto it is not a feature.
   */
  let before;
  await ctx.test('the page loads even when nothing has been lost', async () => {
    before = await api('/api/inventory/wastage');
    assert.ok(before.summary, 'no summary in the response');
    assert.ok(Array.isArray(before.rows), 'no rows in the response');
  });

  let recorded;
  await ctx.test('a loss recorded in one act appears on it', async () => {
    recorded = await api('/api/inventory/wastage', {
      method: 'POST',
      body: {
        variantId: state.variant.id, quantity: 1, reason: 'damage', notes: 'dropped it',
      },
    });
    assert.equal(recorded.status, 'posted');

    const after = await api('/api/inventory/wastage');
    assert.equal(after.summary.documents, before.summary.documents + 1);
    assert.ok(after.summary.value > before.summary.value,
      'a loss valued at nothing is a loss the books will never see');
    assert.ok(after.summary.byReason.some((row) => row.reason === 'damage'));
    assert.ok(after.rows.some((row) => row.id === recorded.id),
      'the document behind the figure is not in the list under it');
  });

  await ctx.test('and the list carries what a person needs to recognise it', async () => {
    const row = (await api('/api/inventory/wastage')).rows.find((r) => r.id === recorded.id);
    assert.equal(row.reason, 'damage');
    assert.equal(row.units, 1);
    assert.ok(row.value > 0);
    assert.ok(row.items, 'no idea which piece was written off');
    assert.ok(row.posted_at, 'no idea when');
  });

  await ctx.test('a reason that is not a loss is refused at this door', async () => {
    // `correction` and `stock_take` are bookkeeping. Letting them in here would
    // pollute the one figure this screen exists to be trusted about.
    await assert.rejects(
      () => api('/api/inventory/wastage', {
        method: 'POST',
        body: { variantId: state.variant.id, quantity: 1, reason: 'correction' },
      }),
      (error) => error.status === 422 || error.status === 400,
    );
  });
});
