/**
 * End to end: the label batch and GET /api/labels/code wiring around the
 * hand-written encoders in src/shared/barcode.js — settings defaults,
 * `symbology` / `codeImage` / `codeAspect` on each label, `qr` kept equal to
 * `codeImage`, and an un-encodable payload reaching the client as a 422.
 * Encoder correctness itself is covered in tests/barcode.test.js.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { initDb, closeDb } from '../src/infrastructure/database/connection.js';
import { ean13CheckDigit } from '../src/shared/barcode.js';

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

test('seeded settings default labels.symbology to code128 and scanner.model to empty', async () => {
  const settings = await api('/api/settings'); // flat { key: value }
  assert.equal(settings['labels.symbology'], 'code128');
  assert.equal(settings['labels.code_height_mm'], 12);
  assert.equal(settings['labels.show_code_text'], true);
  assert.equal(settings['scanner.model'], '');
});

test('GET /api/labels/code defaults to code128 and returns a wide, non-square aspect', async () => {
  const res = await api('/api/labels/code?payload=ABC-123');
  assert.equal(res.symbology, 'code128');
  assert.match(res.dataUri, /^data:image\/svg\+xml;base64,/);
  assert.ok(res.aspect > 2, `a 1D barcode should be wide and short, got aspect ${res.aspect}`);
});

test('GET /api/labels/code with symbology=ean13 encodes a real EAN-13', async () => {
  const res = await api('/api/labels/code?payload=4006381333931&symbology=ean13');
  assert.equal(res.symbology, 'ean13');
  const svg = Buffer.from(res.dataUri.split(',')[1], 'base64').toString('utf8');
  assert.ok(svg.includes('4006381333931'));
});

test('GET /api/labels/code 422s on an un-encodable EAN-13 payload, with a message', async () => {
  await assert.rejects(
    () => api('/api/labels/code?payload=ABC&symbology=ean13'),
    (e) => {
      assert.equal(e.status, 422);
      assert.match(e.payload.error.message, /digit/i);
      return true;
    },
  );
});

test('GET /api/labels/qr is unchanged: still returns a plain { dataUri }', async () => {
  const res = await api('/api/labels/qr?payload=ABC-123');
  assert.deepEqual(Object.keys(res), ['dataUri']);
  assert.match(res.dataUri, /^data:image\/(svg\+xml|png);base64,/);
});

test('buildBatch gains symbology / codeImage / codeAspect, and qr equals codeImage', async () => {
  const attributes = await api('/api/attributes/with-values');
  const size = attributes.rows.find((a) => a.code === 'SIZE');
  const product = await api('/api/products', {
    method: 'POST',
    body: {
      sku_prefix: `LBL-${Date.now().toString().slice(-7)}`,
      name_en: 'Label Test Item',
      name_ar: 'صنف اختبار الملصق',
      tax_rate: 14,
      base_cost: 50,
      base_price: 100,
      attribute_ids: [size.id],
      variants: [{
        cost_price: 50, selling_price: 100, wholesale_price: 80,
        reorder_level: 1, reorder_quantity: 5,
        options: [{ attribute_id: size.id, attribute_value_id: size.values[0].id }],
      }],
    },
  });
  state.variant = product.variants[0];

  const batch = await api('/api/labels/batch', {
    method: 'POST',
    body: { items: [{ variant_id: state.variant.id, copies: 2 }] },
  });
  assert.equal(batch.labels.length, 2);
  for (const label of batch.labels) {
    assert.equal(label.symbology, 'code128');
    assert.match(label.codeImage, /^data:image\/svg\+xml;base64,/);
    assert.ok(label.codeAspect > 2);
    assert.equal(label.qr, label.codeImage, '`qr` must equal `codeImage` this release');
  }
});

test('buildBatch honours a per-request symbology override (ean13) against a barcode-shaped variant', async () => {
  // A fresh product whose variant's barcode is a real, encodable EAN-13.
  // barcode is unique per test run, since it's stored with a UNIQUE constraint.
  const twelve = String(Date.now()).slice(-12).padStart(12, '0');
  const ean = twelve + String(ean13CheckDigit(twelve));

  const attributes = await api('/api/attributes/with-values');
  const size = attributes.rows.find((a) => a.code === 'SIZE');
  const product = await api('/api/products', {
    method: 'POST',
    body: {
      sku_prefix: `LBLE-${Date.now().toString().slice(-6)}`,
      name_en: 'EAN Label Test Item',
      name_ar: 'صنف اختبار EAN',
      tax_rate: 14,
      base_cost: 50,
      base_price: 100,
      attribute_ids: [size.id],
      variants: [{
        cost_price: 50, selling_price: 100, wholesale_price: 80,
        reorder_level: 1, reorder_quantity: 5,
        barcode: ean,
        options: [{ attribute_id: size.id, attribute_value_id: size.values[0].id }],
      }],
    },
  });
  const variant = product.variants[0];
  assert.equal(variant.barcode, ean);

  const batch = await api('/api/labels/batch', {
    method: 'POST',
    body: { items: [{ variant_id: variant.id, copies: 1 }], symbology: 'ean13' },
  });
  assert.equal(batch.labels[0].symbology, 'ean13');
  const svg = Buffer.from(batch.labels[0].codeImage.split(',')[1], 'base64').toString('utf8');
  assert.ok(svg.includes(ean));
});

test('buildBatch 422s when the variant barcode cannot be encoded in the chosen symbology', async () => {
  // The variant's SKU/barcode is not all-digit, so ean13 must reject it.
  const product = await api('/api/products', {
    method: 'POST',
    body: {
      sku_prefix: `LBLX-${Date.now().toString().slice(-6)}`,
      name_en: 'Non Numeric Label Item',
      name_ar: 'صنف بدون رقم',
      tax_rate: 14,
      base_cost: 50,
      base_price: 100,
      attribute_ids: [],
      variants: [{
        cost_price: 50, selling_price: 100, wholesale_price: 80,
        reorder_level: 1, reorder_quantity: 5,
        options: [],
      }],
    },
  });
  const variant = product.variants[0];
  assert.ok(!/^\d+$/.test(variant.sku), 'the SKU must contain letters for this to be a valid test');

  await assert.rejects(
    () => api('/api/labels/batch', {
      method: 'POST',
      body: { items: [{ variant_id: variant.id, copies: 1 }], symbology: 'ean13' },
    }),
    (e) => {
      assert.equal(e.status, 422);
      assert.match(e.payload.error.message, /digit/i);
      return true;
    },
  );
});
