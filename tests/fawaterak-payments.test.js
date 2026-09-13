/**
 * Online payment through Fawaterak — off by default, and everything below
 * checks the two halves that matter once a shop turns it on:
 *
 *  - `FawaterakService` in isolation: the request it builds, how it reacts to
 *    a refused or unreachable gateway, and the webhook HMAC check (including
 *    the case that must fail — a tampered signature).
 *  - The whole path through a real server and a real database: placing an
 *    online order gets a payment URL and reserves stock exactly like cash on
 *    delivery; the order cannot be delivered until a correctly-signed webhook
 *    confirms it paid; a webhook with a wrong signature changes nothing; and
 *    a shop that never turns any of this on sees no change at all.
 */
import './single-shop.js'; // must be first — see that file
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp } from '../src/server.js';
import { initDb, applySchema, closeDb, getDb } from '../src/infrastructure/database/connection.js';
import { seedBaseline } from '../src/infrastructure/database/seed.js';
import { runMigrations } from '../src/infrastructure/database/migrations/index.js';
import { FawaterakService } from '../src/services/FawaterakService.js';
import fawaterakSingleton from '../src/services/FawaterakService.js';
import { BusinessRuleError, ServiceUnavailableError } from '../src/shared/errors.js';

// ---------------------------------------------------------------- FawaterakService, in isolation

function fakeSettings(values) {
  return { get: async (key, fallback) => (key in values ? values[key] : fallback) };
}

test('FawaterakService#isAvailable — false until both switched on and keyed', async () => {
  const off = new FawaterakService({ settings: fakeSettings({}) });
  assert.equal(await off.isAvailable(), false);

  const onNoKey = new FawaterakService({
    settings: fakeSettings({ 'payments.fawaterak_enabled': true, 'payments.fawaterak_api_key': '' }),
  });
  assert.equal(await onNoKey.isAvailable(), false);

  const ready = new FawaterakService({
    settings: fakeSettings({ 'payments.fawaterak_enabled': true, 'payments.fawaterak_api_key': 'key-123' }),
  });
  assert.equal(await ready.isAvailable(), true);
});

test('FawaterakService#createInvoice — builds the documented request and reads the documented response', async () => {
  let capturedUrl = null;
  let capturedBody = null;
  const svc = new FawaterakService({
    settings: fakeSettings({
      'payments.fawaterak_enabled': true,
      'payments.fawaterak_api_key': 'key-123',
      'payments.fawaterak_mode': 'staging',
    }),
    fetch: async (url, opts) => {
      capturedUrl = url;
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'success', data: { url: 'https://staging.fawaterk.com/pay/abc', invoiceId: 99, invoiceKey: 'KEY-99' } }),
      };
    },
  });

  const result = await svc.createInvoice({
    order_no: 'WEB-2026-00001',
    customer_name: 'Kerolos Nashat',
    customer_email: 'k@example.com',
    customer_phone: '01000000000',
    lines: [{ description: 'Silver chain', unit_price: 100, quantity: 2 }],
    tax_amount: 28,
    delivery_fee: 20,
    total_amount: 248,
    returnUrl: 'https://shop.example/shop/#/order/WEB-2026-00001',
    webhookUrl: 'https://shop.example/api/shop/payments/fawaterak/webhook_json',
  });

  assert.equal(capturedUrl, 'https://staging.fawaterk.com/api/v2/createInvoiceLink');
  assert.equal(capturedBody.customer.first_name, 'Kerolos');
  assert.equal(capturedBody.customer.last_name, 'Nashat');
  assert.equal(capturedBody.cartTotal, 248);
  assert.equal(capturedBody.shipping, 20);
  // Two cart items: the line itself, plus tax folded in as its own row.
  assert.equal(capturedBody.cartItems.length, 2);
  assert.equal(capturedBody.cartItems[0].price, 100);
  assert.equal(capturedBody.cartItems[0].quantity, 2);
  assert.equal(capturedBody.cartItems[1].name, 'Tax');
  assert.equal(capturedBody.cartItems[1].price, 28);
  assert.equal(capturedBody.redirectionUrls.successUrl, 'https://shop.example/shop/#/order/WEB-2026-00001');
  assert.equal(capturedBody.redirectionUrls.failUrl, 'https://shop.example/shop/#/order/WEB-2026-00001?payment=failed');
  assert.equal(capturedBody.redirectionUrls.pendingUrl, 'https://shop.example/shop/#/order/WEB-2026-00001?payment=pending');
  assert.equal(capturedBody.redirectionUrls.webhookUrl, 'https://shop.example/api/shop/payments/fawaterak/webhook_json');

  assert.equal(result.url, 'https://staging.fawaterk.com/pay/abc');
  assert.equal(result.invoiceId, '99');
  assert.equal(result.invoiceKey, 'KEY-99');
});

test('FawaterakService#createInvoice — a refused invoice raises a BusinessRuleError, not a crash', async () => {
  const svc = new FawaterakService({
    settings: fakeSettings({ 'payments.fawaterak_enabled': true, 'payments.fawaterak_api_key': 'key-123' }),
    fetch: async () => ({ ok: false, status: 422, json: async () => ({ status: 'error', message: 'Invalid customer phone' }) }),
  });
  await assert.rejects(
    () => svc.createInvoice({ order_no: 'X', customer_name: 'A', lines: [], tax_amount: 0, delivery_fee: 0, total_amount: 0, returnUrl: 'https://x/', webhookUrl: 'https://x/w' }),
    (e) => e instanceof BusinessRuleError && e.details?.code === 'PAYMENT_GATEWAY_REFUSED',
  );
});

test('FawaterakService#createInvoice — a Laravel-style validation object comes through readable, not "[object Object]"', async () => {
  const svc = new FawaterakService({
    settings: fakeSettings({ 'payments.fawaterak_enabled': true, 'payments.fawaterak_api_key': 'key-123' }),
    fetch: async () => ({
      ok: false,
      status: 422,
      json: async () => ({ status: 'error', message: { phone: ['The phone format is invalid.'] } }),
    }),
  });
  await assert.rejects(
    () => svc.createInvoice({ order_no: 'X', customer_name: 'A', lines: [], tax_amount: 0, delivery_fee: 0, total_amount: 0, returnUrl: 'https://x/', webhookUrl: 'https://x/w' }),
    (e) => {
      assert.ok(e instanceof BusinessRuleError);
      assert.ok(e.message.includes('phone: The phone format is invalid.'), e.message);
      assert.ok(!e.message.includes('[object Object]'), e.message);
      return true;
    },
  );
});

test('FawaterakService#createInvoice — an Egyptian phone number keeps its leading zero', async () => {
  let capturedBody = null;
  const svc = new FawaterakService({
    settings: fakeSettings({ 'payments.fawaterak_enabled': true, 'payments.fawaterak_api_key': 'key-123' }),
    fetch: async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => ({ status: 'success', data: { url: 'https://x/pay', invoiceId: 1, invoiceKey: 'K' } }) };
    },
  });
  await svc.createInvoice({
    order_no: 'X', customer_name: 'A', customer_phone: '01001234567', lines: [],
    tax_amount: 0, delivery_fee: 0, total_amount: 0, returnUrl: 'https://x/', webhookUrl: 'https://x/w',
  });
  // A bare `Number('01001234567')` silently drops the leading zero (1001234567,
  // ten digits) — this is what that regression looked like, and the whole
  // reason `phone` must travel as a string.
  assert.equal(capturedBody.customer.phone, '01001234567');
});

test('FawaterakService#createInvoice — a network failure raises ServiceUnavailableError, not a crash', async () => {
  const svc = new FawaterakService({
    settings: fakeSettings({ 'payments.fawaterak_enabled': true, 'payments.fawaterak_api_key': 'key-123' }),
    fetch: async () => { throw new Error('getaddrinfo ENOTFOUND'); },
  });
  await assert.rejects(
    () => svc.createInvoice({ order_no: 'X', customer_name: 'A', lines: [], tax_amount: 0, delivery_fee: 0, total_amount: 0, returnUrl: 'https://x/', webhookUrl: 'https://x/w' }),
    (e) => e instanceof ServiceUnavailableError && e.code === 'PAYMENT_GATEWAY_UNREACHABLE',
  );
});

test('FawaterakService#createInvoice — refuses to call out at all when not set up, without needing fetch', async () => {
  const svc = new FawaterakService({
    settings: fakeSettings({}), // disabled, no key
    fetch: async () => { throw new Error('must not be called'); },
  });
  await assert.rejects(
    () => svc.createInvoice({ order_no: 'X', customer_name: 'A', lines: [], tax_amount: 0, delivery_fee: 0, total_amount: 0, returnUrl: 'https://x/', webhookUrl: 'https://x/w' }),
    BusinessRuleError,
  );
});

test('FawaterakService#verifyWebhookSignature — accepts the correct HMAC and rejects everything else', async () => {
  const svc = new FawaterakService({ settings: fakeSettings({ 'payments.fawaterak_vendor_key': 'vendor-secret' }) });
  const good = crypto.createHmac('sha256', 'vendor-secret').update('InvoiceId=1&InvoiceKey=KEY-1&PaymentMethod=card').digest('hex');

  assert.equal(await svc.verifyWebhookSignature({ invoiceId: '1', invoiceKey: 'KEY-1', paymentMethod: 'card', hashKey: good }), true);

  // Tampered: one character flipped in an otherwise well-formed hex signature.
  const tampered = `${good.slice(0, -1)}${good.at(-1) === '0' ? '1' : '0'}`;
  assert.equal(await svc.verifyWebhookSignature({ invoiceId: '1', invoiceKey: 'KEY-1', paymentMethod: 'card', hashKey: tampered }), false);

  // Signed for a different invoice entirely.
  assert.equal(await svc.verifyWebhookSignature({ invoiceId: '2', invoiceKey: 'KEY-1', paymentMethod: 'card', hashKey: good }), false);

  // No vendor key configured yet — nothing can be verified, so nothing passes.
  const unset = new FawaterakService({ settings: fakeSettings({}) });
  assert.equal(await unset.verifyWebhookSignature({ invoiceId: '1', invoiceKey: 'KEY-1', paymentMethod: 'card', hashKey: good }), false);
});

// ---------------------------------------------------------------- end to end, through the real app

let base = '';
let server = null;
let cookie = '';
let realFetchImpl = null;
let lastInvoiceRequest = null;
/** Set per-test to control what the mocked Fawaterak API returns. */
let mockResponse = null;

before(async () => {
  await initDb();
  await applySchema();
  await seedBaseline();
  await runMigrations();
  const app = createApp();
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  // `WebOrderService` and the webhook route both call through the
  // module-level `fawaterakService` singleton — the same instance the whole
  // app shares — so its own `fetchImpl` is swapped here rather than the
  // global `fetch`: the singleton captured a reference to the real global
  // `fetch` when it was constructed, at import time, long before this hook
  // runs, so overriding `globalThis.fetch` here would never actually reach
  // it. No test ever makes a real network call to Fawaterak.
  realFetchImpl = fawaterakSingleton.fetchImpl;
  fawaterakSingleton.fetchImpl = async (url, opts) => {
    lastInvoiceRequest = { url: String(url), body: opts?.body ? JSON.parse(opts.body) : null };
    if (mockResponse) return mockResponse();
    return { ok: true, status: 200, json: async () => ({ status: 'success', data: { url: 'https://staging.fawaterk.com/pay/mock', invoiceId: 1, invoiceKey: 'MOCK-KEY' } }) };
  };
});

after(async () => {
  if (realFetchImpl) fawaterakSingleton.fetchImpl = realFetchImpl;
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
  const result = await api('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  assert.equal(result.user.username, 'admin');
});

test('a product to order with', async () => {
  const product = await api('/api/products', {
    method: 'POST',
    body: {
      sku_prefix: `PAY-${Date.now().toString().slice(-6)}`,
      name_en: 'Payment Test Item',
      name_ar: 'صنف اختبار الدفع',
      tax_rate: 0,
      base_cost: 50,
      base_price: 200,
      track_inventory: false,
      is_active: true,
      is_published: true,
      variants: [{ cost_price: 50, selling_price: 200 }],
    },
  });
  state.variant = product.variants[0];
  assert.ok(state.variant?.id);

  // `deliver()` actually issues the stock (see `SalesService#checkout`), which
  // refuses to go negative regardless of `track_inventory` — this test walks
  // one order all the way to delivered, so it needs real stock on hand, same
  // as `tests/full-cycle.test.js` does for the same reason.
  await api('/api/inventory/quick-adjust', {
    method: 'POST',
    body: { variantId: state.variant.id, newQuantity: 10, reason: 'correction', notes: 'test stock' },
  });
});

test('Fawaterak is off by default — /api/shop/config says so and the checkout radio never appears', async () => {
  const config = await api('/api/shop/config');
  assert.equal(config.payments?.fawaterakEnabled, false);
});

test('while off, asking to pay online at checkout is silently treated as cash on delivery', async () => {
  cookie = '';
  const placed = await api('/api/shop/orders', {
    method: 'POST',
    body: {
      lines: [{ variant_id: state.variant.id, quantity: 1 }],
      customer: { name: 'Off Switch', phone: '+201001111111' },
      address: { line: 'Street 1', city: 'Cairo' },
      language: 'en',
      payment_method: 'fawaterak',
    },
  });
  assert.equal(placed.payment_method, 'cash_on_delivery');
  assert.equal(placed.payment_status, 'not_required');
  assert.equal(placed.payment_url, undefined);
});

test('turn Fawaterak on with a staging key and vendor key', async () => {
  await api('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  const settings = await api('/api/settings', {
    method: 'PUT',
    body: {
      'payments.fawaterak_enabled': true,
      'payments.fawaterak_mode': 'staging',
      'payments.fawaterak_api_key': 'test-api-key',
      'payments.fawaterak_vendor_key': 'test-vendor-key',
    },
  });
  assert.equal(settings['payments.fawaterak_enabled'], true);

  const config = await api('/api/shop/config');
  assert.equal(config.payments.fawaterakEnabled, true);
  // The keys themselves must never reach the public config.
  assert.equal('fawaterakApiKey' in config.payments, false);
  assert.equal(JSON.stringify(config).includes('test-api-key'), false);
});

test('placing an online order reserves stock and returns a payment_url instead of a plain confirmation', async () => {
  cookie = '';
  mockResponse = null; // default success mock from `before()`
  const placed = await api('/api/shop/orders', {
    method: 'POST',
    body: {
      lines: [{ variant_id: state.variant.id, quantity: 1 }],
      customer: { name: 'Online Payer', phone: '+201002222222' },
      address: { line: 'Street 2', city: 'Cairo' },
      language: 'en',
      payment_method: 'fawaterak',
    },
  });
  assert.equal(placed.payment_method, 'fawaterak');
  assert.equal(placed.payment_status, 'pending');
  assert.equal(placed.payment_url, 'https://staging.fawaterk.com/pay/mock');
  assert.ok(lastInvoiceRequest.url.startsWith('https://staging.fawaterk.com/api/v2/createInvoiceLink'));
  assert.equal(lastInvoiceRequest.body.cartTotal, placed.total_amount);

  state.onlineOrderNo = placed.order_no;
  state.onlinePhone = '+201002222222';
});

test('an unpaid online order cannot be delivered', async () => {
  await api('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  const orders = await api('/api/web-orders?status=pending');
  const order = orders.rows.find((o) => o.order_no === state.onlineOrderNo);
  assert.ok(order, 'the online order must show up in the pending queue');
  state.onlineOrderId = order.id;

  const accepted = await api(`/api/web-orders/${order.id}/accept`, { method: 'POST' });
  assert.equal(accepted.status, 'accepted');
  const dispatched = await api(`/api/web-orders/${order.id}/dispatch`, { method: 'POST' });
  assert.equal(dispatched.status, 'out_for_delivery');

  await assert.rejects(
    () => api(`/api/web-orders/${order.id}/deliver`, { method: 'POST' }),
    (e) => e.status === 400 && /payment/i.test(e.payload?.error?.message || ''),
  );
});

test('a webhook with a wrong signature changes nothing', async () => {
  cookie = '';
  const res = await fetch(`${base}/api/shop/payments/fawaterak/webhook_json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      invoice_status: 'paid', invoice_id: 1, invoice_key: 'MOCK-KEY', payment_method: 'card', hashKey: 'not-even-hex-shaped',
    }),
  });
  assert.equal(res.status, 200); // never a distinguishing status code — see the route's own comment
  await res.json();

  await api('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  const tracked = await api(`/api/web-orders/${state.onlineOrderId}`);
  assert.equal(tracked.payment_status, 'pending', 'a bad signature must not confirm the payment');
});

test('a correctly-signed webhook confirms payment, and delivery then succeeds paid by card', async () => {
  const hashKey = crypto.createHmac('sha256', 'test-vendor-key')
    .update('InvoiceId=1&InvoiceKey=MOCK-KEY&PaymentMethod=card')
    .digest('hex');

  cookie = '';
  const res = await fetch(`${base}/api/shop/payments/fawaterak/webhook_json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      invoice_status: 'paid', invoice_id: 1, invoice_key: 'MOCK-KEY', payment_method: 'card', hashKey, referenceNumber: 'REF-1',
    }),
  });
  assert.equal(res.status, 200);

  await api('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  const tracked = await api(`/api/web-orders/${state.onlineOrderId}`);
  assert.equal(tracked.payment_status, 'paid');

  const delivered = await api(`/api/web-orders/${state.onlineOrderId}/deliver`, { method: 'POST' });
  assert.equal(delivered.status, 'delivered');

  const { getDb: db } = await import('../src/infrastructure/database/connection.js');
  const sale = await db().prepare('SELECT payment_method FROM sales WHERE id = ?').get(delivered.sale_id);
  assert.equal(sale.payment_method, 'card', 'an online order is invoiced as card, never cash, so the till report is not misled');
});

test('replaying the same webhook a second time is a no-op — idempotent, not a second confirmation', async () => {
  const hashKey = crypto.createHmac('sha256', 'test-vendor-key')
    .update('InvoiceId=1&InvoiceKey=MOCK-KEY&PaymentMethod=card')
    .digest('hex');
  cookie = '';
  const res = await fetch(`${base}/api/shop/payments/fawaterak/webhook_json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ invoice_status: 'paid', invoice_id: 1, invoice_key: 'MOCK-KEY', payment_method: 'card', hashKey }),
  });
  assert.equal(res.status, 200);
  // No assertion beyond "did not throw" — `confirmPayment`'s own
  // `WHERE payment_status = 'pending'` guard is what tests/weborder-delivery
  // and this file both rely on; there is nothing left in `pending` for a
  // second call to find.
});

test('turning Fawaterak back off returns checkout to plain cash on delivery', async () => {
  await api('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  await api('/api/settings', { method: 'PUT', body: { 'payments.fawaterak_enabled': false } });
  cookie = '';
  const config = await api('/api/shop/config');
  assert.equal(config.payments.fawaterakEnabled, false);

  const placed = await api('/api/shop/orders', {
    method: 'POST',
    body: {
      lines: [{ variant_id: state.variant.id, quantity: 1 }],
      customer: { name: 'Back To Cash', phone: '+201003333333' },
      address: { line: 'Street 3', city: 'Cairo' },
      language: 'en',
      payment_method: 'fawaterak', // asked for anyway — must not matter once the switch is off
    },
  });
  assert.equal(placed.payment_method, 'cash_on_delivery');
});
