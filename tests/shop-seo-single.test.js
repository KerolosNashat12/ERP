/**
 * The same work, on the build that runs on the shop's own counter PC.
 *
 * `src/server.js` mounts the storefront's pages, `robots.txt` and `sitemap.xml`
 * twice — once under `/t/:slug` for the fleet and once at the root for a
 * deployment that serves one shop. Rule 1 of the platform contract is that the
 * single-shop build behaves as it did before multi-tenancy existed, so the
 * shorter path gets its own file rather than being assumed to work because the
 * longer one does.
 *
 * The difference that matters here: on this build the ERP is at `/`. So
 * `robots.txt` has to refuse the root and allow `/shop` back out of it, which
 * is the opposite shape from the fleet's and the one that would be easiest to
 * get quietly wrong.
 */
import './single-shop.js'; // must be first — see that file
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'data', 'shop-seo-single-test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
process.env.MM_DB_FILE = path.join(dir, 'shop.db');

const { createApp } = await import('../src/server.js');
const {
  initDb, applySchema, closeDb, getDb,
} = await import('../src/infrastructure/database/connection.js');

let base = '';
let server = null;

before(async () => {
  await initDb();
  await applySchema();
  const db = getDb();
  for (const [key, value] of Object.entries({
    'company.name': 'Corner Shop',
    'company.name_ar': 'محل الركن',
    'web.meta_description_ar': 'كل حاجة للبيت، من محل الركن في طنطا.',
  })) {
    await db.prepare('INSERT OR REPLACE INTO settings (key, value, value_type) VALUES (?, ?, ?)').run(key, value, 'string');
  }
  await db.prepare("INSERT INTO brands (id, code, name_en, name_ar) VALUES (1, 'B1', 'House', 'البيت')").run();
  await db.prepare(`
    INSERT INTO products (id, sku_prefix, name_en, name_ar, description_ar, brand_id,
                          base_price, is_active, is_published)
    VALUES (1, 'K1', 'Copper kettle', 'كنكة نحاس', 'كنكة نحاس مشغولة باليد، مقاس وسط.', 1, 120, 1, 1)
  `).run();
  await db.prepare("INSERT INTO product_variants (product_id, sku, selling_price, is_active) VALUES (1, 'K1-A', 120, 1)").run();

  const app = createApp();
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

const get = async (p) => {
  const res = await fetch(`${base}${p}`, { redirect: 'manual' });
  return { status: res.status, headers: res.headers, body: await res.text() };
};

test('a product page on the single-shop build carries its own head', async () => {
  const page = await get('/shop/product/1');
  assert.equal(page.status, 200);
  assert.match(page.body, /<title>كنكة نحاس — محل الركن<\/title>/);
  assert.match(page.body, /<meta name="description" content="كنكة نحاس مشغولة باليد، مقاس وسط\."/);
  assert.match(page.body, new RegExp(`<link rel="canonical" href="${base}/shop/product/1/`));
  assert.doesNotMatch(page.body, /<title>المتجر<\/title>/, 'the shell placeholder is replaced, not joined');
});

test('robots.txt refuses the ERP at the root and allows the shop back', async () => {
  const robots = await get('/robots.txt');
  assert.equal(robots.status, 200);
  assert.match(robots.body, /^Disallow: \/$/m, 'the ERP lives at / on this build');
  assert.match(robots.body, /^Allow: \/shop$/m);
  assert.match(robots.body, /^Disallow: \/shop\/checkout$/m);
  assert.match(robots.body, /^Allow: \/shared\/$/m, 'the storefront\'s own modules must stay fetchable');
  assert.match(robots.body, new RegExp(`^Sitemap: ${base}/sitemap\\.xml$`, 'm'));
  assert.doesNotMatch(robots.body, /\/t\//, 'and says nothing about a fleet that is not here');
});

test('the sitemap lists this shop at the root', async () => {
  const index = await get('/sitemap.xml');
  assert.equal(index.status, 200);
  assert.match(index.body, new RegExp(`${base}/sitemap/products-1\\.xml`));

  const products = await get('/sitemap/products-1.xml');
  assert.match(products.body, new RegExp(`<loc>${base}/shop/product/1/`));
  assert.match(products.body, /hreflang="x-default"/);
});

test('the ERP shell is still served at the root, and still says noindex', async () => {
  const erp = await get('/');
  assert.equal(erp.status, 200);
  assert.match(erp.body, /<title>ERP<\/title>/);
  assert.match(erp.body, /<meta name="robots" content="noindex, nofollow"/);
});
