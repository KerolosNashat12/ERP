/**
 * DOWNLOADING "ALL PRODUCTS" HAS TO MEAN ALL OF THEM, NOT ONE PAGE OF THEM.
 *
 * The exact shape of bug this project has already shipped once — the stock
 * count sheet asked its repository for one page of up to 1000 and returned
 * it (see `tests/count-sheet.test.js`). `ProductRepository#search` clamps
 * `pageSize` at 500 the same way, so a CSV export that asked for one page of
 * "everything" would silently stop at product 500 on any shop bigger than
 * that, with nothing on the download saying so. `CatalogService#exportRows`
 * exists so the caller pages until it has read as many rows as `total` said
 * there were.
 *
 * Two layers: a fake repository proves the PAGING is correct without
 * inserting 501 real rows, and a real HTTP request against a small seeded
 * shop proves the CSV a person actually downloads is shaped and labelled
 * right, in both languages, and still needs `products.view` to reach at all.
 */
import './single-shop.js'; // must be first — see that file
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { CatalogService } from '../src/services/CatalogService.js';

/**
 * A stand-in for `ProductRepository#search`, because the thing under test is
 * how the SERVICE pages — and a fake is the only way to hold a catalogue of a
 * given size without inserting thousands of products for every case.
 *
 * It reproduces the one behaviour that caused the count-sheet bug and would
 * hide this one too: `pageSize` clamped, `total` reporting the whole
 * catalogue regardless of what one page returned.
 */
function fakeProducts(productCount) {
  const all = Array.from({ length: productCount }, (_, i) => ({
    id: i + 1,
    sku_prefix: `SKU-${String(i + 1).padStart(5, '0')}`,
    name_en: `Product ${i + 1}`,
  }));
  const calls = [];
  return {
    calls,
    async search({ page = 1, pageSize = 25, ...filters } = {}) {
      const size = Math.min(Math.max(Number(pageSize) || 25, 1), 500);
      const current = Math.max(Number(page) || 1, 1);
      calls.push({ page: current, pageSize: size, filters });
      return {
        rows: all.slice((current - 1) * size, current * size),
        total: all.length,
        page: current,
        pageSize: size,
        pages: Math.ceil(all.length / size) || 1,
      };
    },
  };
}

test('a catalogue smaller than one page is fetched in one call', async () => {
  const products = fakeProducts(120);
  const service = new CatalogService({ products });
  const rows = await service.exportRows({ brandId: 7 });
  assert.equal(rows.length, 120);
  assert.equal(rows[0].sku_prefix, 'SKU-00001');
  assert.equal(rows[119].sku_prefix, 'SKU-00120');
  assert.equal(products.calls.length, 1, 'a small catalogue should not cost extra round trips');
  assert.equal(products.calls[0].filters.brandId, 7, 'the caller\'s own filters reach every page');
});

test('a catalogue past the 500-row page ceiling is not truncated at it', async () => {
  const products = fakeProducts(650);
  const service = new CatalogService({ products });
  const rows = await service.exportRows({});
  assert.equal(rows.length, 650, 'every product, not the first page of them');
  assert.equal(rows[0].sku_prefix, 'SKU-00001');
  assert.equal(rows[649].sku_prefix, 'SKU-00650');
  assert.ok(products.calls.length >= 2, 'a catalogue bigger than one page must ask for a second one');
  // Every page asked for the SAME filters — the loop must not lose them
  // partway through, which is exactly the kind of thing a hasty rewrite drops.
  for (const call of products.calls) assert.deepEqual(call.filters, {});
});

test('an empty catalogue is one call and no rows, not an infinite loop', async () => {
  const products = fakeProducts(0);
  const service = new CatalogService({ products });
  const rows = await service.exportRows({});
  assert.equal(rows.length, 0);
  assert.equal(products.calls.length, 1);
});

/* ═══════════════════════════════════════════════════════ the real HTTP door */

const { initDb, applySchema, closeDb } = await import('../src/infrastructure/database/connection.js');
const { seedBaseline } = await import('../src/infrastructure/database/seed.js');
const { runMigrations } = await import('../src/infrastructure/database/migrations/index.js');
const { createApp } = await import('../src/server.js');

let base = '';
let server = null;
let cookie = '';

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
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closeDb();
});

let requestNo = 0;
async function api(path, { method = 'GET', body, raw = false } = {}) {
  requestNo += 1;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `products-export-${process.pid}-${Date.now()}-${requestNo}`,
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  if (raw) return res;
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const err = new Error(data?.error?.message || `HTTP ${res.status} on ${path}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

test('login as administrator', async () => {
  const result = await api('/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'admin123' },
  });
  assert.equal(result.user.username, 'admin');
});

const TAG = `PXP-${Date.now().toString().slice(-6)}`;
let hiddenSku;

test('fixture: one active, published product and one inactive, unpublished one', async () => {
  const brand = await api('/api/brands', { method: 'POST', body: { name_en: `Brand ${TAG}`, name_ar: `ماركة ${TAG}` } });
  const category = await api('/api/categories', { method: 'POST', body: { name_en: `Cat ${TAG}`, name_ar: `فئة ${TAG}` } });

  const active = await api('/api/products', {
    method: 'POST',
    body: {
      sku_prefix: `${TAG}-A`, name_en: 'Active Published Item', name_ar: 'صنف فعال', tax_rate: 14,
      base_cost: 100, base_price: 250, gender: 'men', is_active: 1, is_published: 1,
      brand_id: brand.id, category_id: category.id,
      variants: [{ cost_price: 100, selling_price: 250 }],
    },
  });
  assert.equal(active.is_active, 1);

  const hidden = await api('/api/products', {
    method: 'POST',
    body: {
      sku_prefix: `${TAG}-H`, name_en: 'Hidden Draft Item', name_ar: 'صنف مخفي', tax_rate: 14,
      base_cost: 60, base_price: 150, gender: 'women', is_active: 0, is_published: 0,
      brand_id: brand.id, category_id: category.id,
      variants: [{ cost_price: 60, selling_price: 150 }],
    },
  });
  hiddenSku = hidden.sku_prefix;
  assert.equal(hidden.is_active, 0);
});

test('CSV export carries both fixture products, correctly labelled, in English', async () => {
  const res = await api(`/api/products?format=csv&search=${encodeURIComponent(TAG)}`, { raw: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /products\.csv/);
  const text = await res.text();
  const lines = text.replace(/^﻿/, '').split('\n').filter(Boolean);
  const header = lines[0];
  assert.match(header, /SKU/);
  assert.match(header, /Product/);
  assert.match(header, /Status/);
  assert.match(header, /Gender/);
  assert.ok(lines.some((l) => l.includes('Active Published Item') && l.includes('Active') && l.includes('Men')),
    'the active product is rows and labelled correctly');
  assert.ok(lines.some((l) => l.includes('Hidden Draft Item') && l.includes('Inactive') && l.includes('Hidden')),
    'the hidden product is in the export too — export is not the same thing as the storefront');
});

test('CSV export in Arabic uses Arabic headers and Arabic labels', async () => {
  const res = await api(`/api/products?format=csv&lang=ar&search=${encodeURIComponent(TAG)}`, { raw: true });
  const text = await res.text();
  const header = text.replace(/^﻿/, '').split('\n')[0];
  assert.match(header, /الكود/);
  assert.match(header, /الحالة/);
  assert.ok(text.includes('مفعل'), 'the active label reads in Arabic');
  assert.ok(text.includes('مفقل') || text.includes('غير مفعل'), 'the inactive label reads in Arabic');
});

test('the isActive filter on the export matches the filter on the screen', async () => {
  const res = await api(`/api/products?format=csv&search=${encodeURIComponent(TAG)}&isActive=0`, { raw: true });
  const text = await res.text();
  assert.ok(text.includes('Hidden Draft Item'));
  assert.ok(!text.includes('Active Published Item'), 'the active-only filter left the active product out');
  assert.ok(hiddenSku, 'fixture ran');
});

test('a stranger cannot reach the export any more than the list it is next to', async () => {
  const saved = cookie;
  cookie = '';
  const res = await api('/api/products?format=csv', { raw: true });
  assert.equal(res.status, 401);
  cookie = saved;
});
