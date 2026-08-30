/**
 * PICTURES MUST LOAD WHEN THE ERP IS SERVED UNDER `/t/<slug>/`.
 *
 * The source fence (`tests/asset-urls.test.js`) proves no view builds a
 * picture's address by hand. This proves the addresses the helpers build are
 * actually FETCHABLE from the deployment shape where the old ones were not —
 * which is the only place the bug ever showed itself.
 *
 * So this boots the ERP in PLATFORM mode with a default tenant, gives a brand
 * a logo and a product a photograph through the real endpoints, opens the two
 * screens at `/t/<slug>/#/…` in a real browser, and asks each `<img>` whether
 * it decoded. `naturalWidth === 0` is exactly what the owner photographed: a
 * torn-page icon where a logo should be.
 *
 * Run it directly — it starts and stops its own server:
 *     node tests/tenant-assets-check.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'data', 'tenant-assets-check');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

const SLUG = 'assetshop';
process.env.MM_DATA_DIR = dir;
process.env.MM_DB_URL = `file:${path.join(dir, 'shop.db')}`;
process.env.MM_DB_DRIVER = 'libsql';
process.env.MM_JWT_SECRET = 'tenant-assets-check-secret';
process.env.MM_PLATFORM = '1';
process.env.MM_DEFAULT_TENANT = SLUG;
process.env.MM_PLATFORM_OWNER_PASSWORD = 'owner-password-for-check';
process.env.MM_BCRYPT_ROUNDS = '4';
delete process.env.MM_PLATFORM_DB_URL;

const { createApp, ensureDatabaseReady } = await import('../src/server.js');
const { closeDb } = await import('../src/infrastructure/database/connection.js');
const { closePlatformDb } = await import('../src/platform/db.js');

const failures = [];
const notes = [];
const fail = (m) => failures.push(m);
const note = (m) => notes.push(m);

await ensureDatabaseReady();
const server = await new Promise((resolve) => {
  const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
});
const BASE = `http://127.0.0.1:${server.address().port}`;
const PREFIX = `${BASE}/t/${SLUG}`;

/* ── sign in and give a brand and a product something to show ───────────── */
const login = await fetch(`${PREFIX}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
});
if (!login.ok) {
  fail(`could not sign in to the tenant: ${login.status}`);
} else {
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const json = (path_, init = {}) => fetch(`${PREFIX}${path_}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', cookie, ...(init.headers || {}) },
  });

  // A 2x2 red PNG — the smallest thing that can be told apart from a broken image.
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91J'
    + 'pzAAAAEUlEQVR4nGP8z4APMOGVHTbSAA2eAQd4pySWAAAAAElFTkSuQmCC';

  /*
   * An adopted shop starts with an administrator and nothing else, so the two
   * things being photographed are made here rather than assumed. That is the
   * right way round anyway: a check that leans on seed data silently stops
   * checking the day the seed changes.
   */
  const madeBrand = await json('/api/brands', {
    method: 'POST',
    body: JSON.stringify({ name_en: 'Marque', name_ar: 'مارك', is_active: 1 }),
  });
  const brand = madeBrand.ok ? await madeBrand.json() : null;
  if (!brand) fail(`could not create a brand: ${madeBrand.status} ${(await madeBrand.text()).slice(0, 160)}`);
  else {
    const r = await json(`/api/brands/${brand.id}/logo`, {
      method: 'PUT', body: JSON.stringify({ dataUrl: PNG }),
    });
    if (!r.ok) fail(`uploading a brand logo answered ${r.status}`);
    else note(`brand ${brand.id} has a logo`);
  }

  const madeProduct = await json('/api/products', {
    method: 'POST',
    body: JSON.stringify({
      sku_prefix: 'ASSET', name_en: 'A photographed thing', name_ar: 'حاجة مصورة',
      base_price: 100,
      variants: [{ sku: 'ASSET-1', variant_label: 'one', cost_price: 10, selling_price: 100 }],
    }),
  });
  const product = madeProduct.ok ? await madeProduct.json() : null;
  let productId = product?.id ?? null;
  if (!product) fail(`could not create a product: ${madeProduct.status} ${(await madeProduct.text()).slice(0, 160)}`);
  else {
    const r = await json(`/api/products/${productId}/images`, {
      method: 'POST', body: JSON.stringify({ dataUrl: PNG }),
    });
    if (!r.ok) fail(`uploading a product photo answered ${r.status} ${(await r.text()).slice(0, 160)}`);
    else note(`product ${productId} has a photograph`);
  }
  if (!productId) { fail('nothing to photograph — the rest of the check cannot run'); }

  /* ── now look at it the way he did ────────────────────────────────────── */
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const notFound = [];
  page.on('response', (res) => {
    if (res.status() === 404 && res.url().includes('/api/')) notFound.push(res.url().replace(BASE, ''));
  });

  await page.goto(`${PREFIX}/`);
  await page.waitForTimeout(600);
  await page.fill('input[name=username]', 'admin');
  await page.fill('input[name=password]', 'admin123');
  await page.click('form button[type=submit]');
  await page.waitForTimeout(2500);

  const screens = [
    ['brands', `${PREFIX}/#/brands`, '.brand-logo-chip'],
    // The photos card lives at the foot of a product's own edit screen.
    ['product photos', `${PREFIX}/#/products/${productId}/edit`, '.photo-grid .photo-tile img'],
  ];

  for (const [name, url, selector] of screens) {
    await page.goto(url);
    await page.waitForTimeout(2600);
    const seen = await page.evaluate((sel) => {
      const imgs = [...document.querySelectorAll(sel)];
      return {
        count: imgs.length,
        broken: imgs.filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.getAttribute('src')),
        sample: imgs[0]?.getAttribute('src') || null,
      };
    }, selector);

    if (!seen.count) {
      fail(`[${name}] no <img> matched "${selector}" — the check cannot see what it is judging`);
      continue;
    }
    if (seen.broken.length) {
      fail(`[${name}] ${seen.broken.length} of ${seen.count} picture(s) did not load: ${seen.broken.join(', ')}`);
    }
    if (seen.sample && !seen.sample.startsWith(`/t/${SLUG}/`)) {
      fail(`[${name}] address "${seen.sample}" is missing the tenant prefix`);
    }
    /*
     * Reported from what was MEASURED, not from what was hoped: an earlier
     * version of this line said "all decoded" unconditionally and printed it
     * on a run where nothing decoded at all. A note that cannot be wrong is
     * worth more than a tidy one.
     */
    const loaded = seen.count - seen.broken.length;
    note(`[${name}] ${loaded}/${seen.count} picture(s) decoded · ${seen.sample}`);
  }

  if (notFound.length) fail(`404s while drawing the screens: ${[...new Set(notFound)].join(', ')}`);
  await browser.close();
}

server.close();
await closeDb();
await closePlatformDb();

for (const n of notes) console.log(`  · ${n}`);
if (failures.length) {
  console.error(`\n✘ ${failures.length} problem(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n✔ tenant assets: every picture loads under /t/<slug>/, prefix and all');
process.exit(0);
