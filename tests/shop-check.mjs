/**
 * Storefront checks for the two fixes the shop owner reported.
 *
 *  1. A quantity cannot be raised past what the shop actually has, on the
 *     product page or in the cart, and a basket restored from `localStorage`
 *     with a stale quantity is clamped when the cart opens.
 *  2. Product cards in a grid are the same box whatever shape the photograph
 *     was, at every width and in both languages.
 *
 * Run the fixture first (`node tests/shop-fixture.mjs`), then:
 *   node tests/shop-check.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.MM_TEST_URL || 'http://127.0.0.1:4000';
const SHOP = `${BASE}/shop/`;
const OUT = '/tmp/fix-shots';
fs.mkdirSync(OUT, { recursive: true });

const WIDTHS = [360, 768, 1280];
const LANGS = ['ar', 'en'];

const failures = [];
const measured = [];
const fail = (msg) => failures.push(msg);
const round = (n) => Math.round(n * 100) / 100;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});

async function openPage(width, lang) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.on('pageerror', (err) => fail(`[pageerror ${lang}@${width}] ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') fail(`[console ${lang}@${width}] ${msg.text()}`);
  });
  await page.goto(SHOP);
  await page.evaluate((l) => window.localStorage.setItem('mm.shop.lang', l), lang);
  // The language and the basket are both read once, when the modules load, so
  // a hash change is not enough — the document has to come back.
  await page.reload();
  await page.waitForTimeout(400);
  return page;
}

/** Navigate to a hash route from a cold document, not by changing the hash. */
async function open(page, route) {
  await page.goto(`${SHOP}#/${route}`);
  await page.reload();
}

// ===========================================================================
// FIX 2 — every card the same box, every photo the same box
// ===========================================================================
for (const width of WIDTHS) {
  for (const lang of LANGS) {
    const page = await openPage(width, lang);
    await open(page, 'products');
    await page.waitForSelector('.grid .card', { timeout: 20000 });
    await page.waitForTimeout(1200);

    const dir = await page.evaluate(() => document.documentElement.dir);
    if (dir !== (lang === 'ar' ? 'rtl' : 'ltr')) fail(`[dir] ${lang}@${width} got dir=${dir}`);

    const cards = await page.$$eval('.grid .card', (nodes) => nodes.map((card) => {
      const box = card.getBoundingClientRect();
      const photo = card.querySelector('.photo').getBoundingClientRect();
      const price = card.querySelector('.card-price').getBoundingClientRect();
      const name = card.querySelector('.card-name').getBoundingClientRect();
      return {
        label: card.querySelector('.card-name').textContent.slice(0, 28),
        empty: card.querySelector('.photo').classList.contains('photo-empty'),
        x: box.x, y: box.y, w: box.width, h: box.height,
        pw: photo.width, ph: photo.height,
        priceBottomGap: box.bottom - price.bottom,
        nameH: name.height,
      };
    }));

    if (cards.length < 6) fail(`[grid] ${lang}@${width} only ${cards.length} cards rendered`);
    if (!cards.some((c) => c.empty)) fail(`[grid] ${lang}@${width} no photo-less card in the fixture`);

    // Rows, by the y each card starts at (rounded — sub-pixel layout is fine).
    const rows = new Map();
    for (const card of cards) {
      const key = Math.round(card.y);
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push(card);
    }
    if (rows.size < 2) fail(`[grid] ${lang}@${width} expected more than one row, got ${rows.size}`);

    for (const [y, row] of rows) {
      const same = (key) => row.every((c) => Math.abs(c[key] - row[0][key]) < 0.5);
      if (!same('w')) fail(`[card-width] ${lang}@${width} row y=${y}: ${row.map((c) => round(c.w))}`);
      if (!same('h')) fail(`[card-height] ${lang}@${width} row y=${y}: ${row.map((c) => round(c.h))}`);
      if (!same('pw')) fail(`[photo-width] ${lang}@${width} row y=${y}: ${row.map((c) => round(c.pw))}`);
      if (!same('ph')) fail(`[photo-height] ${lang}@${width} row y=${y}: ${row.map((c) => round(c.ph))}`);
      // The price must sit the same distance off the bottom of every card in
      // the row — that is what "pinned to the bottom" means when measured.
      if (!same('priceBottomGap')) {
        fail(`[price-baseline] ${lang}@${width} row y=${y}: ${row.map((c) => round(c.priceBottomGap))}`);
      }
      if (!same('nameH')) fail(`[name-height] ${lang}@${width} row y=${y}: ${row.map((c) => round(c.nameH))}`);
    }

    // Across the whole grid, not just within a row.
    const first = cards[0];
    for (const card of cards) {
      if (Math.abs(card.w - first.w) > 0.5 || Math.abs(card.h - first.h) > 0.5) {
        fail(`[grid-uniform] ${lang}@${width} "${card.label}" is ${round(card.w)}x${round(card.h)}, expected ${round(first.w)}x${round(first.h)}`);
      }
      if (Math.abs(card.pw - first.pw) > 0.5 || Math.abs(card.ph - first.ph) > 0.5) {
        fail(`[photo-uniform] ${lang}@${width} "${card.label}" photo is ${round(card.pw)}x${round(card.ph)}`);
      }
      if (Math.abs(card.pw - card.ph) > 0.5) {
        fail(`[photo-square] ${lang}@${width} "${card.label}" photo is not square: ${round(card.pw)}x${round(card.ph)}`);
      }
    }

    measured.push({
      view: `${lang}@${width}`,
      cards: cards.length,
      rows: rows.size,
      card: `${round(first.w)} x ${round(first.h)}`,
      photo: `${round(first.pw)} x ${round(first.ph)}`,
    });

    await page.screenshot({ path: `${OUT}/grid-${lang}-${width}.png`, fullPage: true });

    // --- the product page gallery must not jump when a photo is swapped
    await open(page, 'product/3'); // FIXWIDE: a 1200x300 and a 400x400
    await page.waitForSelector('.gallery-main .photo', { timeout: 20000 });
    await page.waitForTimeout(1000);
    const before = await page.$eval('.gallery-main', (n) => {
      const b = n.getBoundingClientRect();
      return { w: b.width, h: b.height };
    });
    const thumbs = await page.locator('.thumb').count();
    if (thumbs < 2) fail(`[gallery] ${lang}@${width} expected thumbnails on product 3, got ${thumbs}`);
    const thumbBoxes = await page.$$eval('.thumb', (nodes) => nodes.map((n) => {
      const b = n.getBoundingClientRect();
      return { w: b.width, h: b.height };
    }));
    for (const box of thumbBoxes) {
      if (Math.abs(box.w - thumbBoxes[0].w) > 0.5 || Math.abs(box.h - thumbBoxes[0].h) > 0.5
          || Math.abs(box.w - box.h) > 0.5) {
        fail(`[thumb] ${lang}@${width} thumbnails differ: ${JSON.stringify(thumbBoxes)}`);
      }
    }
    await page.locator('.thumb').nth(1).click();
    await page.waitForTimeout(700);
    const after = await page.$eval('.gallery-main', (n) => {
      const b = n.getBoundingClientRect();
      return { w: b.width, h: b.height };
    });
    if (Math.abs(before.h - after.h) > 0.5 || Math.abs(before.w - after.w) > 0.5) {
      fail(`[gallery-jump] ${lang}@${width} ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    }
    measured.push({
      view: `${lang}@${width} gallery`,
      main: `${round(before.w)} x ${round(before.h)}`,
      thumb: `${round(thumbBoxes[0].w)} x ${round(thumbBoxes[0].h)}`,
    });
    await page.screenshot({ path: `${OUT}/product-${lang}-${width}.png`, fullPage: true });

    await page.close();
  }
}

// ===========================================================================
// FIX 1 — the stepper stops at `available`
// ===========================================================================
{
  const page = await openPage(1280, 'ar');
  page.on('dialog', (d) => d.dismiss());

  // Product 2 (FIXTALL) has 7 units.
  await open(page, 'product/2');
  await page.waitForSelector('.buy-row .stepper', { timeout: 20000 });
  await page.waitForTimeout(900);

  const plus = page.locator('.buy-row .step').nth(1);
  for (let i = 0; i < 20; i += 1) {
    if (await plus.isDisabled()) break;
    await plus.click();
  }
  const reached = await page.locator('.buy-row .qty-value').textContent();
  if (reached.trim() !== '7') fail(`[stepper] stopped at ${reached}, expected 7`);
  if (!(await plus.isDisabled())) fail('[stepper] + is still enabled at the cap');

  const note = (await page.locator('.buy-row .stock-note').textContent()).trim();
  if (!note.includes('7')) fail(`[stock-note] said "${note}"`);
  await page.screenshot({ path: `${OUT}/stepper-cap-ar.png`, fullPage: false });
  measured.push({ view: 'stepper ar', stoppedAt: reached.trim(), note });

  // English wording of the same line.
  await page.evaluate(() => window.localStorage.setItem('mm.shop.lang', 'en'));
  await page.reload();
  await page.waitForSelector('.buy-row .stepper', { timeout: 20000 });
  await page.waitForTimeout(900);
  const plusEn = page.locator('.buy-row .step').nth(1);
  for (let i = 0; i < 20; i += 1) {
    if (await plusEn.isDisabled()) break;
    await plusEn.click();
  }
  const noteEn = (await page.locator('.buy-row .stock-note').textContent()).trim();
  if (noteEn !== 'Only 7 left') fail(`[stock-note en] said "${noteEn}"`);
  measured.push({ view: 'stepper en', note: noteEn });
  await page.screenshot({ path: `${OUT}/stepper-cap-en.png`, fullPage: false });

  // An out-of-stock product stays refused (product 7, FIXOUT).
  await open(page, 'product/7');
  await page.waitForSelector('.btn-add', { timeout: 20000 });
  await page.waitForTimeout(800);
  if (!(await page.locator('.btn-add').isDisabled())) fail('[out] add button enabled on a sold-out product');

  // An untracked product (8, FIXFREE) keeps an uncapped stepper and says nothing.
  await open(page, 'product/8');
  await page.waitForSelector('.buy-row .stepper', { timeout: 20000 });
  await page.waitForTimeout(800);
  const plusFree = page.locator('.buy-row .step').nth(1);
  for (let i = 0; i < 5; i += 1) await plusFree.click();
  const freeQty = (await page.locator('.buy-row .qty-value').textContent()).trim();
  if (freeQty !== '6') fail(`[untracked] stepper reached ${freeQty}, expected 6`);
  if (await page.locator('.buy-row .stock-note:not([hidden])').count()) {
    fail('[untracked] a stock line was shown for a product with no stock to track');
  }
  await page.close();
}

// ===========================================================================
// FIX 1 — a hand-edited localStorage cart is clamped when the cart opens
// ===========================================================================
{
  const page = await openPage(1280, 'en');
  // Variant 7 of product 2 has 7 in stock; variant 12 (product 7) has none.
  await page.evaluate(() => window.localStorage.setItem('mm.shop.cart.v1', JSON.stringify([
    {
      variant_id: 7, product_id: 2, name_en: 'Tall portrait clutch', name_ar: 'كلتش طولي',
      label: 'Default', price: 250, tax_rate: 14, image_id: null, qty: 40,
    },
    {
      variant_id: 12, product_id: 7, name_en: 'Sold out piece', name_ar: 'قطعة خلصت',
      label: 'Default', price: 250, tax_rate: 14, image_id: null, qty: 3,
    },
  ])));

  await open(page, 'cart');
  await page.waitForSelector('.cart-line', { timeout: 20000 });
  await page.waitForTimeout(2000);

  const stored = await page.evaluate(() => JSON.parse(window.localStorage.getItem('mm.shop.cart.v1')));
  if (stored.length !== 1) fail(`[cart-clamp] expected the sold-out line to be dropped, got ${JSON.stringify(stored)}`);
  if (stored[0]?.qty !== 7) fail(`[cart-clamp] qty is ${stored[0]?.qty}, expected 7`);

  const shownQty = (await page.locator('.cart-line .qty-value').first().textContent()).trim();
  if (shownQty !== '7') fail(`[cart-clamp] the page shows ${shownQty}, expected 7`);

  const told = await page.locator('.toast').count();
  if (!told) fail('[cart-clamp] the customer was not told the basket changed');

  const cartPlus = page.locator('.cart-line .step').nth(1);
  if (!(await cartPlus.isDisabled())) fail('[cart-stepper] + is enabled at the cap');
  await cartPlus.click({ force: true }).catch(() => {});
  await page.waitForTimeout(400);
  const afterPush = (await page.locator('.cart-line .qty-value').first().textContent()).trim();
  if (afterPush !== '7') fail(`[cart-stepper] a forced click pushed it to ${afterPush}`);

  const cartNote = (await page.locator('.cart-line .stock-note').first().textContent()).trim();
  if (cartNote !== 'Only 7 left') fail(`[cart-note] said "${cartNote}"`);
  measured.push({ view: 'cart clamp', storedQty: stored[0]?.qty, lines: stored.length, note: cartNote });

  await page.screenshot({ path: `${OUT}/cart-clamped-en.png`, fullPage: true });

  // And the same page in Arabic, for the screenshot record.
  await page.evaluate(() => window.localStorage.setItem('mm.shop.lang', 'ar'));
  await page.reload();
  await page.waitForSelector('.cart-line', { timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/cart-clamped-ar.png`, fullPage: true });
  await page.close();
}

await browser.close();

console.log('MEASURED');
console.table(measured);
console.log('screenshots ->', OUT);

if (failures.length) {
  console.log('\nFAILURES:');
  console.log([...new Set(failures)].join('\n'));
  process.exit(1);
}
console.log('\nAll storefront checks passed.');
