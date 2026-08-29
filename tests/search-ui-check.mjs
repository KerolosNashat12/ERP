/**
 * THE SUGGESTION LIST, IN A REAL BROWSER, IN BOTH LANGUAGES.
 *
 * What the unit tests cannot answer: does a person SEE the suggestion, can
 * they reach it with the keyboard, does clicking it go anywhere, and — the one
 * that would end this shop's day — does the barcode scanner still work now
 * that there is a menu attached to the box it scans into?
 *
 * That last question is why this file exists. The topbar box is where every
 * scan in the shop lands. A dropdown that swallowed Enter would break every
 * sale, and no unit test of a search service would notice.
 *
 * Run the server on 4000 first, then:  node tests/search-ui-check.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.MM_TEST_URL || 'http://127.0.0.1:4000';
const failures = [];
const notes = [];
const fail = (m) => failures.push(m);
const note = (m) => notes.push(m);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});

/** Sign in, set the language, and clear whatever dialog the shell opened. */
async function erpPage(lang) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  await page.goto(`${BASE}/`);
  await page.waitForTimeout(500);
  await page.fill('input[name=username]', 'admin');
  await page.fill('input[name=password]', 'admin123');
  await page.click('form button[type=submit]');
  await page.waitForTimeout(2200);
  // AFTER sign-in: the login page resets it, so setting it earlier runs in
  // English twice and the Arabic half of this check proves nothing.
  await page.evaluate((l) => localStorage.setItem('mm.lang', l), lang);
  await page.reload();
  await page.waitForTimeout(1600);
  for (const title of ['Change password', 'تغيير كلمة المرور']) {
    const stray = page.locator('#modal-root .modal').filter({ hasText: title });
    if (await stray.count()) {
      await stray.first().locator('.modal-head button').click();
      await page.waitForTimeout(250);
    }
  }
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
  return { page, errs };
}

const type = async (box, text, delay = 90) => { await box.click(); await box.type(text, { delay }); };

/** A real variant code from this shop, for the scan test below. */
const scanCode = await (async () => {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const page1 = await (await fetch(`${BASE}/api/products?page=1&pageSize=1`, { headers: { cookie } })).json();
  const product = await (await fetch(`${BASE}/api/products/${page1.rows[0].id}`, { headers: { cookie } })).json();
  const variant = product.variants[0];
  return variant.barcode || variant.sku;
})();
note(`scanning a real code from this shop: ${scanCode}`);

/* ═══════════════════════════ 1. the ERP, in both languages ════════════════ */

for (const lang of ['ar', 'en']) {
  const { page, errs } = await erpPage(lang);
  const box = page.locator('.topbar-scan input');
  const menu = page.locator('.suggest-menu:not([hidden])');

  await type(box, 'toba');
  await page.waitForTimeout(1100);
  if (!(await menu.count())) {
    fail(`[${lang}] no suggestions for "toba"`);
  } else {
    const text = await menu.innerText();
    if (!/Tobacco|توباكو/.test(text)) fail(`[${lang}] the product is not in the list: ${text.replace(/\n/g, ' | ')}`);
    if (/\bnull\b|undefined|\[object/.test(text)) fail(`[${lang}] raw JS leaked into the list: ${text}`);
    note(`[${lang}] "toba" → ${text.replace(/\n/g, ' · ')}`);
  }

  /*
   * THE SCAN. The whole point of this file.
   *
   * Typed at scanner speed (a real Zebex sends a character every few
   * milliseconds) and finished with Enter. The box must clear — which is what
   * `triggerScan` does — and no menu must be sitting open over the page.
   */
  await box.fill('');
  await page.waitForTimeout(400);
  await box.click();
  // A code this shop actually has — read from its own catalogue rather than
  // written here, so the check cannot rot against a reseeded database and
  // cannot pass by scanning something that was never going to resolve.
  await box.type(scanCode, { delay: 4 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  if ((await box.inputValue()) !== '') {
    fail(`[${lang}] a scan did not clear the box — Enter was swallowed by the menu`);
  }
  if (await menu.count()) {
    fail(`[${lang}] a menu is open over the page after a scan`);
  }
  note(`[${lang}] scan at 4ms/char: box cleared, no menu`);

  /*
   * Keyboard navigation: down-arrow highlights, Enter opens — and Enter must
   * be taken by the LIST ONLY.
   *
   * Both the suggestion list and the barcode scanner want that key press. When
   * the list takes it, the scanner must not also fire a lookup for the
   * half-typed word: `toba` is not a code, so the shop got a failed-scan sound
   * and a red toast on top of a page that had navigated correctly. Watching
   * the network is the only way to see it — the screen looks right.
   */
  const scanLookups = [];
  const watch = (req) => {
    if (req.url().includes('/api/products/scan/')) {
      scanLookups.push(decodeURIComponent(req.url().split('/scan/')[1]));
    }
  };
  page.on('request', watch);

  await box.fill('');
  await type(box, 'toba');
  await page.waitForTimeout(1100);
  if (await menu.count()) {
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(150);
    const active = page.locator('.suggest-row.is-active');
    if (!(await active.count())) fail(`[${lang}] ArrowDown highlights nothing`);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1400);
    if (!/#\/products\/\d+/.test(page.url())) {
      fail(`[${lang}] Enter on a highlighted row went to ${page.url()}`);
    } else {
      note(`[${lang}] keyboard → ${page.url().split('#')[1]}`);
    }
    if (scanLookups.length) {
      fail(`[${lang}] opening a suggestion also fired a barcode lookup for ${JSON.stringify(scanLookups)}`);
    }
  }
  page.off('request', watch);

  if (errs.length) fail(`[${lang}] ${errs.join(' / ')}`);
  await page.close();
}

/* ═════════════════════════════════ 2. the storefront, both templates ══════ */

for (const template of ['classic', 'luxe']) {
  // Set the shop's template through the API, the way the ERP does.
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  await fetch(`${BASE}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ 'web.template': template }),
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  await page.goto(`${BASE}/shop/`);
  await page.waitForTimeout(1400);

  const box = page.locator('.search-input');
  if (!(await box.count())) { fail(`[shop ${template}] no search box`); await page.close(); continue; }
  await type(box, 'tabaco');           // a typo, so the note is exercised too
  await page.waitForTimeout(1200);

  const menu = page.locator('.search-menu:not([hidden])');
  if (!(await menu.count())) {
    fail(`[shop ${template}] no suggestions for a misspelled name`);
  } else {
    const text = await menu.innerText();
    if (!/Tobacco|توباكو/.test(text)) fail(`[shop ${template}] the product is missing: ${text}`);
    if (/\bnull\b|undefined/.test(text)) fail(`[shop ${template}] raw JS leaked: ${text}`);

    /*
     * The menu must be READABLE against the page it is on. The luxe storefront
     * is near-black and the classic one is white; a panel that inherited the
     * wrong one is invisible, and no assertion about its text would notice.
     */
    const contrast = await menu.evaluate((node) => {
      const bg = getComputedStyle(node).backgroundColor;
      const fg = getComputedStyle(node).color;
      const rgb = (s) => (s.match(/\d+/g) || [0, 0, 0]).slice(0, 3).map(Number);
      const lum = (c) => {
        const [r, g, b] = rgb(c).map((v) => {
          const x = v / 255;
          return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const a = lum(bg); const b = lum(fg);
      return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
    });
    if (contrast < 4.5) fail(`[shop ${template}] the suggestion panel is unreadable (contrast ${contrast}:1)`);
    note(`[shop ${template}] "tabaco" → ${text.replace(/\n/g, ' · ')} (contrast ${contrast}:1)`);

    // Clicking one goes to that product.
    await page.locator('.search-item').first().click();
    await page.waitForTimeout(1400);
    if (!/\/shop\/product\//.test(page.url())) {
      fail(`[shop ${template}] clicking a suggestion went to ${page.url()}`);
    }
  }
  if (errs.length) fail(`[shop ${template}] ${errs.join(' / ')}`);
  await page.close();
}

// Leave the shop as it was found.
{
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  await fetch(`${BASE}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', cookie: login.headers.get('set-cookie').split(';')[0] },
    body: JSON.stringify({ 'web.template': 'classic' }),
  });
}

await browser.close();
console.log(notes.map((n) => `  · ${n}`).join('\n'));
if (failures.length) {
  console.log(`\n✘ ${failures.length} problem(s):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\n✔ suggestions: visible, navigable, readable — and the scanner still scans');
