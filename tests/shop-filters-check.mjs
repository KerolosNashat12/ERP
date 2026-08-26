/**
 * A real browser, on the real storefront: does the filter panel work, and does
 * a sale price render the way it is meant to?
 *
 * The API tests prove the numbers. This proves the page — that the panel opens
 * on a phone, that ticking a box narrows the grid, that the choice survives a
 * reload because it is in the URL, and that a discounted card draws three
 * things and not one.
 *
 * Run against a server the caller started, whose shop must have at least one
 * PUBLISHED PRODUCT ON OFFER and at least one that is not — otherwise "the
 * filter did not narrow the grid" is the fixture's fault rather than the
 * page's, which cost twenty minutes the first time it happened.
 */
import { chromium } from 'playwright';

const BASE = process.env.MM_TEST_URL || 'http://127.0.0.1:4000';
const SHOP = `${BASE}/shop/`;
const failures = [];
const fail = (m) => failures.push(m);
const browser = await chromium.launch({
  executablePath: process.env.MM_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});

async function open(width, lang) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.on('pageerror', (e) => fail(`[pageerror ${lang}@${width}] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') fail(`[console ${lang}@${width}] ${m.text()}`); });
  /*
   * The language is written BEFORE the first navigation, and the listing is
   * opened in one go. Two lessons, both learned the hard way here: a second
   * `goto` that differs only by a fragment does not re-route the app, and
   * `/shop/` redirects to `/shop`, which drops the fragment on the way.
   */
  await page.addInitScript((l) => window.localStorage.setItem('mm.shop.lang', l), lang);
  await page.goto(`${SHOP}#/products`);
  await page.waitForSelector('.grid .card', { timeout: 15000 });
  await page.waitForSelector('.filters-toggle, .filters-panel', { timeout: 15000, state: 'attached' });
  return page;
}

for (const [width, lang] of [[1280, 'en'], [390, 'ar']]) {
  const page = await open(width, lang);
  const wide = width >= 900;

  // --- the sale card
  const sale = await page.evaluate(() => {
    const card = document.querySelector('.card-price.is-sale');
    if (!card) return null;
    const flash = document.querySelector('.card-sale');
    return {
      now: card.querySelector('.price-now')?.textContent?.trim(),
      was: card.querySelector('s.price-was')?.textContent?.trim(),
      off: card.querySelector('.price-off')?.textContent?.trim(),
      flash: flash?.textContent?.trim() || null,
      struck: card.querySelector('s.price-was')
        ? getComputedStyle(card.querySelector('s.price-was')).textDecorationLine
        : null,
    };
  });
  if (!sale) fail(`[${lang}@${width}] no discounted card rendered`);
  else {
    if (!sale.now || !sale.was || !sale.off) fail(`[${lang}@${width}] sale card incomplete: ${JSON.stringify(sale)}`);
    if (sale.struck !== 'line-through') fail(`[${lang}@${width}] the old price is not struck through (${sale.struck})`);
    if (!sale.flash) fail(`[${lang}@${width}] no sale flash on the photo`);
    if (sale.now === sale.was) fail(`[${lang}@${width}] the two prices are identical: ${sale.now}`);
  }

  // --- the panel: visible as a column, or behind a button
  const toggleVisible = await page.evaluate(() => {
    const b = document.querySelector('.filters-toggle');
    return b ? getComputedStyle(b).display !== 'none' : false;
  });
  if (wide && toggleVisible) fail(`[${lang}@${width}] the toggle should be hidden on a wide screen`);
  if (!wide && !toggleVisible) fail(`[${lang}@${width}] no way to open the filters on a phone`);

  if (!wide) {
    await page.click('.filters-toggle');
    await page.waitForTimeout(320);
    const open = await page.evaluate(() => {
      const p = document.querySelector('.filters-panel');
      const r = p.getBoundingClientRect();
      return { open: p.classList.contains('is-open'), top: r.top, bottom: r.bottom, h: r.height };
    });
    if (!open.open) fail(`[${lang}@${width}] the sheet did not open`);
    if (open.h < 100) fail(`[${lang}@${width}] the sheet has no height`);
    if (open.bottom > 901) fail(`[${lang}@${width}] the sheet hangs off the bottom (${open.bottom})`);
  }

  // --- ticking a box narrows the grid AND changes the address
  const before = await page.$$eval('.grid .card', (n) => n.length);
  /*
   * The offers switch hides its <input> under a styled label, so a click on the
   * input itself is intercepted by the label — exactly as it is for a real
   * finger. Click what the shopper clicks: the row.
   */
  const box = await page.$('label[for="f-sale"]')
    || await page.$('.filter-option')
    || await page.$('.filter-option input');
  if (!box) fail(`[${lang}@${width}] no filter control rendered`);
  else {
    await box.click();
    await page.waitForTimeout(600);
    const after = await page.$$eval('.grid .card', (n) => n.length);
    const url = page.url();
    if (!/sale=1|gender=|attr=/.test(url)) fail(`[${lang}@${width}] the choice is not in the URL: ${url}`);
    if (after >= before) fail(`[${lang}@${width}] the filter did not narrow the grid (${before} → ${after})`);

    // …and survives a reload, because the URL is the state.
    await page.reload();
    await page.waitForSelector('.grid .card', { timeout: 15000 });
  await page.waitForSelector('.filters-toggle, .filters-panel', { timeout: 15000, state: 'attached' });
    const reloaded = await page.$$eval('.grid .card', (n) => n.length);
    if (reloaded !== after) fail(`[${lang}@${width}] the filter did not survive a reload (${after} → ${reloaded})`);
  }

  // --- nothing scrolls sideways
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) fail(`[${lang}@${width}] the page scrolls sideways by ${overflow}px`);

  await page.close();
}

await browser.close();
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('filter panel: all checks passed');
