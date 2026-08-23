/**
 * The acceptance test for "clicking Save twice creates two purchase orders",
 * done the way the owner does it: in a browser, on the Save button, five times,
 * fast.
 *   node tests/double-click-check.mjs
 *
 * It runs the same shop twice — once with the server guard switched off
 * (`MM_IDEMPOTENCY=0`), which is what the code did before this round, and once
 * with it on — so the number in the report is a before and an after rather than
 * an assertion that something works.
 *
 * Four measurements, because "one purchase order" can be true for two different
 * reasons and only one of them survives a bad connection:
 *
 *   1. GUARD OFF, five requests fired straight at the API from the page. This
 *      is the bug, reproduced: five purchase orders.
 *   2. GUARD ON, the same five raw requests, with no help from the browser at
 *      all — no button to disable, no key sent. This is the server half on its
 *      own, which is what covers a retransmitted request, a page restored from
 *      the back-forward cache and a second tab.
 *   3. GUARD ON, five real clicks on the real Save button. Both halves, the
 *      thing the owner actually reported.
 *   4 & 5. The same before and after on the storefront's "place order" — the
 *      same bug with a customer's money behind it. That screen already greyed
 *      its own button out, so the measurement that matters there is the raw
 *      one: five requests with no button in the way.
 *
 * Development aid, like `ui-check.mjs` and `shop-check.mjs` beside it, and it
 * needs a browser, so it is not part of `npm test`.
 */
import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const dataDir = path.join(root, 'data', 'double-click-check');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const failures = [];
const check = (label, actual, expected) => {
  const ok = actual === expected;
  console.log(`  ${ok ? '✔' : '✖'} ${label}: ${actual} (expected ${expected})`);
  if (!ok) failures.push(`${label}: got ${actual}, expected ${expected}`);
};

// --------------------------------------------------------------- the shop

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'ignore' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${args.join(' ')} exited ${code}`))));
    child.on('error', reject);
  });
}

/** A fresh single-shop database with the example catalogue in it. */
async function buildDatabase(file) {
  const env = { MM_DB_FILE: file, MM_PLATFORM: '0' };
  await run(process.execPath, ['scripts/migrate.js'], env);
  await run(process.execPath, ['scripts/seed.js', '--demo'], env);
}

/**
 * Put the demo catalogue in the shop window.
 *
 * `db:demo` seeds a back office, not a storefront — nothing it creates is
 * published, and an unpublished product cannot be bought, which is the correct
 * default and useless for measuring a checkout. Written straight into the file
 * rather than through the ERP's screens: this is fixture setup, not the thing
 * under test.
 */
function publishCatalogue(file) {
  const db = new DatabaseSync(file);
  db.exec('UPDATE brands SET is_published = 1');
  db.exec('UPDATE categories SET is_published = 1');
  db.exec("UPDATE products SET is_published = 1, published_at = datetime('now')");
  db.exec(`INSERT INTO stock_levels (variant_id, warehouse_id, quantity, average_cost)
           SELECT v.id, 1, 99, v.cost_price FROM product_variants v
           WHERE NOT EXISTS (SELECT 1 FROM stock_levels s
                             WHERE s.variant_id = v.id AND s.warehouse_id = 1)`);
  db.exec('UPDATE stock_levels SET quantity = 99, reserved_quantity = 0');
  db.close();
}

/** A server of its own, so each pass gets its own `MM_IDEMPOTENCY`. */
async function startServer(file, port, env) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      MM_DB_FILE: file,
      MM_PLATFORM: '0',
      MM_PORT: String(port),
      MM_OPEN_BROWSER: 'false',
      ...env,
    },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return { child, base };
    } catch { /* still starting */ }
    await new Promise((r) => { setTimeout(r, 150); });
  }
  child.kill();
  throw new Error(`server on ${port} never came up`);
}

const stop = (server) => new Promise((resolve) => {
  server.child.on('exit', resolve);
  server.child.kill();
});

// ------------------------------------------------------------- the counting

/** Signed in over HTTP, so the counts are read the way any other client would. */
async function session(base) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  if (!res.ok) throw new Error(`could not sign in: ${res.status}`);
  return res.headers.get('set-cookie').split(';')[0];
}

async function count(base, cookie, resource) {
  const res = await fetch(`${base}/api/${resource}?pageSize=1`, { headers: { cookie } });
  const body = await res.json();
  return body.total;
}

/** One variant that exists in the demo catalogue, to order and to sell. */
async function anyVariant(base, cookie) {
  const res = await fetch(`${base}/api/products/lookup?q=a`, { headers: { cookie } });
  const { rows } = await res.json();
  if (!rows?.length) throw new Error('the demo catalogue has no products to order');
  return rows[0];
}

// ---------------------------------------------------------------- browser

async function signIn(page, base) {
  await page.goto(base);
  await page.waitForSelector('.login-card');
  await page.fill('input[name=username]', 'admin');
  await page.fill('input[name=password]', 'admin123');
  await page.click('button[type=submit]');
  await page.waitForSelector('.shell', { timeout: 15000 });
  await page.waitForTimeout(1200);
  // The forced password-change dialog, if this database has never been used.
  if (await page.locator('.modal-head').count()) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
  }
}

/**
 * Five identical POSTs from the page, all in flight at once, with no
 * `Idempotency-Key` and no button involved.
 *
 * This is what a browser retransmitting on a bad connection looks like from
 * the server's side, and it is the case the button cannot help with — which is
 * exactly why it is measured separately from the clicks.
 */
async function fiveRawPosts(page, base, variantId) {
  return page.evaluate(async ({ variant }) => {
    const body = JSON.stringify({
      supplier_id: 1,
      order_date: new Date().toISOString().slice(0, 10),
      discount_amount: 0,
      shipping_amount: 0,
      lines: [{ variant_id: variant, quantity_ordered: 3, unit_cost: 10, discount_percent: 0, tax_rate: 0 }],
    });
    const shots = Array.from({ length: 5 }, () => fetch('/api/purchases', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body,
    }).then((r) => r.status));
    return Promise.all(shots);
  }, { variant: variantId });
}

/** A new purchase order, filled in, with Save pressed five times in one burst. */
async function fiveSaveClicks(page, base, sku) {
  await page.goto(`${base}/#/purchases/new`);
  await page.waitForSelector('select[name=supplier_id]');

  // Whatever supplier the demo data made first. The field is required, so it
  // has no blank placeholder option — the first option IS a supplier.
  await page.waitForFunction(() => document
    .querySelector('select[name=supplier_id]')?.options.length > 0);
  const supplier = await page.$eval('select[name=supplier_id]', (s) => s.options[0].value);
  await page.selectOption('select[name=supplier_id]', supplier);

  // The picker takes a scanned code and Enter, which is how a line is added at
  // the counter.
  await page.fill('input[data-scan-target="true"]', sku);
  await page.keyboard.press('Enter');
  await page.waitForSelector('table.data tbody tr', { timeout: 5000 });

  // Five clicks inside ONE task: no awaiting, no re-render in between, nothing
  // for the page to notice between them. A person cannot press a button this
  // fast; the point is that even this makes one purchase order.
  await page.evaluate(() => {
    const save = [...document.querySelectorAll('.page-head button')]
      .find((b) => b.textContent.trim() === 'Save');
    if (!save) throw new Error('no Save button on the purchase order editor');
    for (let i = 0; i < 5; i += 1) save.click();
  });
  await page.waitForTimeout(3500);
}

/**
 * Five identical checkout requests at once, straight from the page.
 *
 * The storefront's own checkout screen already greyed its button out before
 * this round, so real taps alone would have looked fine — and a customer on a
 * metro whose phone retransmits would still have bought twice. This measures
 * that, the part no button can reach.
 */
async function fiveRawOrders(page, variant) {
  return page.evaluate(async (line) => {
    const body = JSON.stringify({
      lines: [{ variant_id: line, quantity: 1 }],
      customer: { name: 'Mona Adel', phone: '01000000000' },
      address: { line: '12 Nile Street', city: 'Cairo' },
    });
    const shots = Array.from({ length: 5 }, () => fetch('/api/shop/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    }).then((r) => r.status));
    return Promise.all(shots);
  }, variant.variant_id);
}

/** The storefront checkout, with "place order" tapped five times in one burst. */
async function fiveCheckoutTaps(page, base, variant) {
  await page.goto(`${base}/shop`);
  await page.waitForTimeout(800);
  await page.evaluate((line) => {
    window.localStorage.setItem('mm.shop.cart.v1', JSON.stringify([line]));
  }, {
    variant_id: variant.variant_id,
    product_id: variant.product_id || null,
    name_en: variant.product_name_en || 'Item',
    name_ar: variant.product_name_ar || 'صنف',
    label: variant.variant_label || '',
    price: Number(variant.selling_price) || 10,
    tax_rate: Number(variant.tax_rate) || 0,
    image_id: null,
    qty: 1,
  });

  // A hash-only `goto` is a same-document navigation, so the cart module would
  // still be holding the empty basket it read on first paint. Reload, and the
  // page comes up with the basket a shopper would actually have.
  await page.goto(`${base}/shop#/checkout`);
  await page.reload();
  await page.waitForSelector('#checkout-form', { timeout: 15000 });
  await page.fill('#checkout-form input[name=name]', 'Mona Adel');
  await page.fill('#checkout-form input[name=phone]', '01000000000');
  await page.fill('#checkout-form input[name=city]', 'Cairo');
  await page.fill('#checkout-form textarea[name=line], #checkout-form input[name=line]', '12 Nile Street');

  await page.evaluate(() => {
    const button = document.querySelector('button[form="checkout-form"]')
      || document.querySelector('#checkout-form button[type=submit]');
    if (!button) throw new Error('no place-order button on the checkout page');
    for (let i = 0; i < 5; i += 1) button.click();
  });
  await page.waitForTimeout(3500);
}

// -------------------------------------------------------------------- run

fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME });

/** One pass: its own database, its own server, its own page. */
async function pass({ label, port, env, prepare, work }) {
  const file = path.join(dataDir, `${label}.db`);
  await buildDatabase(file);
  if (prepare) prepare(file);
  const server = await startServer(file, port, env);
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  page.on('pageerror', (error) => console.log(`    [pageerror] ${error.message}`));
  try {
    const cookie = await session(server.base);
    await work({ page, base: server.base, cookie });
  } finally {
    await page.close();
    await stop(server);
  }
}

console.log('\n1. GUARD OFF — five requests at once, the bug as reported');
await pass({
  label: 'guard-off',
  port: 4801,
  env: { MM_IDEMPOTENCY: '0' },
  work: async ({ page, base, cookie }) => {
    const variant = await anyVariant(base, cookie);
    const before = await count(base, cookie, 'purchases');
    await signIn(page, base);
    await fiveRawPosts(page, base, variant.variant_id);
    await page.waitForTimeout(800);
    check('purchase orders created', (await count(base, cookie, 'purchases')) - before, 5);
  },
});

console.log('\n2. GUARD ON — the same five requests, no browser help at all');
await pass({
  label: 'guard-on-raw',
  port: 4802,
  env: {},
  work: async ({ page, base, cookie }) => {
    const variant = await anyVariant(base, cookie);
    const before = await count(base, cookie, 'purchases');
    await signIn(page, base);
    await fiveRawPosts(page, base, variant.variant_id);
    await page.waitForTimeout(800);
    check('purchase orders created', (await count(base, cookie, 'purchases')) - before, 1);
  },
});

console.log('\n3. GUARD ON — five real clicks on the real Save button');
await pass({
  label: 'guard-on-clicks',
  port: 4803,
  env: {},
  work: async ({ page, base, cookie }) => {
    const variant = await anyVariant(base, cookie);
    const before = await count(base, cookie, 'purchases');
    await signIn(page, base);
    await fiveSaveClicks(page, base, variant.sku);
    check('purchase orders created', (await count(base, cookie, 'purchases')) - before, 1);
  },
});

console.log('\n4. GUARD OFF — five checkout requests at once, the same bug in the shop');
await pass({
  label: 'shop-guard-off',
  port: 4804,
  env: { MM_IDEMPOTENCY: '0' },
  prepare: publishCatalogue,
  work: async ({ page, base, cookie }) => {
    const variant = await anyVariant(base, cookie);
    const before = await count(base, cookie, 'web-orders');
    await page.goto(`${base}/shop`);
    await page.waitForTimeout(800);
    await fiveRawOrders(page, variant);
    await page.waitForTimeout(800);
    check('web orders created', (await count(base, cookie, 'web-orders')) - before, 5);
  },
});

console.log('\n5. GUARD ON — five real taps on the storefront checkout');
await pass({
  label: 'guard-on-checkout',
  port: 4805,
  env: {},
  prepare: publishCatalogue,
  work: async ({ page, base, cookie }) => {
    const variant = await anyVariant(base, cookie);
    const before = await count(base, cookie, 'web-orders');
    await fiveCheckoutTaps(page, base, variant);
    check('web orders created', (await count(base, cookie, 'web-orders')) - before, 1);

    // And the same five as raw requests, which is the half the greyed-out
    // button never covered.
    const beforeRaw = await count(base, cookie, 'web-orders');
    await page.goto(`${base}/shop`);
    await page.waitForTimeout(600);
    await fiveRawOrders(page, variant);
    await page.waitForTimeout(800);
    check('web orders from five raw requests', (await count(base, cookie, 'web-orders')) - beforeRaw, 1);
  },
});

await browser.close();

if (failures.length) {
  console.error(`\n✖ ${failures.length} check(s) failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\n✔ one save, one document — in a real browser, on both screens\n');
