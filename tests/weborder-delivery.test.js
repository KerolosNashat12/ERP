/**
 * End to end: the delivery fee an order is actually charged must be the exact
 * number `deliveryFor()` would compute for that basket, in percent mode. This
 * is the one place the order table and the shop's arithmetic are proven to
 * agree — everything else is opinion about the rule, this is the rule applied.
 *
 * Also covers: `/api/shop/config` still returns `deliveryFee` and
 * `freeDeliveryOver` at the top level unchanged, and settings write
 * validation rejects a bad enum / an out-of-range `banner_box_width`.
 */
import './single-shop.js'; // must be first — see that file
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { initDb, closeDb } from '../src/infrastructure/database/connection.js';
import { deliveryFor } from '../src/shared/delivery.js';



let base = process.env.MM_TEST_URL || '';
let server = null;
let cookie = '';

before(async () => {
  if (base) return;
  await initDb();
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

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}${path}`, {
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

test('login as administrator', async () => {
  const result = await api('/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'admin123' },
  });
  assert.equal(result.user.username, 'admin');
});

test('switch shipping to percent mode with a min and no max', async () => {
  const settings = await api('/api/settings', {
    method: 'PUT',
    body: {
      'shop.delivery_mode': 'percent',
      'shop.delivery_percent': 10,
      'shop.delivery_min': 50,
      'shop.delivery_max': 0, // no cap
      'shop.free_delivery_over': 0, // disabled — must not accidentally zero the fee below
    },
  });
  assert.equal(settings['shop.delivery_mode'], 'percent');
  assert.equal(settings['shop.delivery_percent'], 10);
  assert.equal(settings['shop.delivery_min'], 50);
});

test('a published, untracked product exists to order', async () => {
  const product = await api('/api/products', {
    method: 'POST',
    body: {
      sku_prefix: `DLV-${Date.now().toString().slice(-6)}`,
      name_en: 'Delivery Test Item',
      name_ar: 'صنف اختبار الشحن',
      tax_rate: 14,
      base_cost: 200,
      base_price: 500,
      track_inventory: false, // nothing to reserve — this test is about pricing, not stock
      is_active: true,
      is_published: true,
      variants: [{ cost_price: 200, selling_price: 500 }],
    },
  });
  state.variant = product.variants[0];
  assert.ok(state.variant?.id);
});

test('placing a web order charges exactly what deliveryFor() computes', async () => {
  // Public routes: log out of the ERP session first, since /api/shop/orders
  // is the unauthenticated storefront checkout.
  cookie = '';

  const placed = await api('/api/shop/orders', {
    method: 'POST',
    body: {
      lines: [{ variant_id: state.variant.id, quantity: 3 }], // 3 x 500 = 1500 + 14% tax
      customer: { name: 'Delivery Tester', phone: '+201001234567' },
      address: { line: '1 Test Street', city: 'Giza' },
      language: 'en',
    },
  });

  const expectedSubtotal = 1500;
  const expectedTax = 210; // 14% of 1500
  const expectedGoods = expectedSubtotal + expectedTax;

  assert.equal(placed.subtotal, expectedSubtotal);
  assert.equal(placed.tax_amount, expectedTax);

  // The independent computation, run here exactly as `WebOrderService.#totals`
  // runs it internally — same function, same settings, called a second time
  // from outside the service under test.
  const expectedDeliveryFee = deliveryFor(expectedGoods, {
    mode: 'percent', fee: 0, percent: 10, min: 50, max: null, freeOver: null,
  });
  assert.equal(placed.delivery_fee, expectedDeliveryFee);
  assert.equal(placed.total_amount, Math.round((expectedGoods + expectedDeliveryFee) * 100) / 100);

  state.orderNo = placed.order_no;
});

test('the stored order agrees with itself on tracking lookup', async () => {
  const tracked = await api(`/api/shop/orders/${encodeURIComponent(state.orderNo)}?phone=${encodeURIComponent('+201001234567')}`);
  const goods = tracked.subtotal + tracked.tax_amount;
  const expectedDeliveryFee = deliveryFor(goods, {
    mode: 'percent', fee: 0, percent: 10, min: 50, max: null, freeOver: null,
  });
  assert.equal(tracked.delivery_fee, expectedDeliveryFee);
});

test('a client-supplied delivery figure is ignored — the server is the only authority', async () => {
  cookie = '';
  const placed = await api('/api/shop/orders', {
    method: 'POST',
    body: {
      lines: [{ variant_id: state.variant.id, quantity: 1 }],
      customer: { name: 'Delivery Tester Two', phone: '+201009876543' },
      address: { line: '2 Test Street', city: 'Giza' },
      language: 'en',
      // Not part of the schema at all — proves the field is simply not read,
      // rather than merely overwritten.
      delivery_fee: 1,
      deliveryFee: 999999,
    },
  });
  const goods = 500 + 70; // 1 x 500 + 14% tax
  const expectedDeliveryFee = deliveryFor(goods, {
    mode: 'percent', fee: 0, percent: 10, min: 50, max: null, freeOver: null,
  });
  assert.equal(placed.delivery_fee, expectedDeliveryFee);
  assert.notEqual(placed.delivery_fee, 999999);
});

test('/api/shop/config still returns deliveryFee and freeDeliveryOver at the top level', async () => {
  const config = await api('/api/shop/config');
  assert.equal(typeof config.deliveryFee, 'number');
  assert.ok('freeDeliveryOver' in config);
  // Round-2 additions live alongside, not instead of, the round-1 shape.
  assert.ok(config.delivery);
  assert.equal(config.delivery.mode, 'percent');
  assert.equal(config.delivery.percent, 10);
  assert.equal(config.delivery.min, 50);
  assert.equal(config.delivery.max, null);
  assert.ok(config.banner);
  assert.equal(config.banner.align, 'right');
  assert.equal(config.banner.boxWidth, 45);
});

test('config normalises an unrecognised stored enum to the documented default', async () => {
  // Written directly, bypassing the write-path validation under test below —
  // this simulates a hand-edited row or an older build's value, which is
  // exactly the case the read-side normalisation exists for.
  cookie = '';
  await api('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  const { getDb } = await import('../src/infrastructure/database/connection.js');
  await getDb().prepare("UPDATE settings SET value = 'middle' WHERE key = 'web.banner_align'").run();
  await getDb().prepare('UPDATE settings SET value = ? WHERE key = ?').run('500', 'web.banner_box_width');

  const config = await api('/api/shop/config');
  assert.equal(config.banner.align, 'right', 'an invalid horizontal position falls back to the default');
  assert.equal(config.banner.boxWidth, 100, 'an out-of-range width clamps to the nearest bound');

  // Put it back through the validated write path so later tests see the default.
  await api('/api/settings', { method: 'PUT', body: { 'web.banner_align': 'right', 'web.banner_box_width': 45 } });
});

test('settings write path rejects an unknown enum value with 422', async () => {
  await assert.rejects(
    () => api('/api/settings', { method: 'PUT', body: { 'web.banner_align': 'middle' } }),
    (e) => e.status === 422,
  );
});

test('settings write path rejects banner_box_width outside 30-100 with 422', async () => {
  await assert.rejects(
    () => api('/api/settings', { method: 'PUT', body: { 'web.banner_box_width': 500 } }),
    (e) => e.status === 422,
  );
  await assert.rejects(
    () => api('/api/settings', { method: 'PUT', body: { 'web.banner_box_width': 10 } }),
    (e) => e.status === 422,
  );
});

test('settings write path rejects an unknown delivery mode with 422', async () => {
  await assert.rejects(
    () => api('/api/settings', { method: 'PUT', body: { 'shop.delivery_mode': 'expensive' } }),
    (e) => e.status === 422,
  );
});
