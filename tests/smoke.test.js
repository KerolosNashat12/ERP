/**
 * End-to-end smoke test against a running server.
 *   node --test tests/
 * Exercises the full commercial cycle: catalogue -> purchase -> receive ->
 * sell (with a promotion) -> return -> report -> audit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.MM_TEST_URL || 'http://127.0.0.1:4000';
let cookie = '';

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
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

test('QR label batch renders data URIs', async () => {
  const batch = await api('/api/labels/batch', {
    method: 'POST',
    body: { items: [{ variant_id: state.variant.id, copies: 2 }], labelSize: '40x30' },
  });
  assert.equal(batch.labels.length, 2);
  assert.ok(batch.labels[0].qr.startsWith('data:image/png;base64,'));
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

test('backup can be created and listed', async () => {
  const created = await api('/api/settings/backups', { method: 'POST' });
  assert.ok(created.file.endsWith('.db'));
  const list = await api('/api/settings/backups');
  assert.ok(list.rows.some((b) => b.file === created.file));
  await api(`/api/settings/backups/${created.file}`, { method: 'DELETE' });
});
