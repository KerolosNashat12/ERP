/**
 * Headless UI walkthrough — visits every screen, captures console errors and
 * screenshots. Development aid, not part of the shipped app.
 *   node tests/ui-check.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.MM_TEST_URL || 'http://127.0.0.1:4000';
const OUT = '/tmp/mm-shots';
fs.mkdirSync(OUT, { recursive: true });

const errors = [];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });

page.on('console', (msg) => {
  // The pre-login /auth/me probe returns 401 by design — not a defect.
  if (msg.type() === 'error' && !msg.text().includes('401')) errors.push(`[console] ${msg.text()}`);
});
page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));

async function shot(name) {
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
}

await page.goto(BASE);
await page.waitForSelector('.login-card');
await shot('01-login');

await page.fill('input[name=username]', 'admin');
await page.fill('input[name=password]', 'admin123');
await page.click('button[type=submit]');
await page.waitForSelector('.shell', { timeout: 15000 });
// Dismiss the forced password-change dialog if it appears.
await page.waitForTimeout(1200);
if (await page.locator('.modal-head').count()) {
  await page.keyboard.press('Escape').catch(() => {});
}
await shot('02-dashboard');

const screens = [
  ['pos', '03-pos'],
  ['products', '04-products'],
  ['inventory', '05-inventory'],
  ['purchases', '06-purchases'],
  ['sales', '07-sales'],
  ['returns', '07b-returns'],
  ['returns/new', '07c-return-new'],
  ['customers', '08-customers'],
  ['suppliers', '09-suppliers'],
  ['brands', '10-brands'],
  ['categories', '11-categories'],
  ['attributes', '12-attributes'],
  ['promotions', '13-promotions'],
  ['reports', '14-reports'],
  ['movements', '15-movements'],
  ['adjustments', '17-adjustments'],
  ['labels', '18-labels'],
  ['users', '19-users'],
  ['audit', '20-audit'],
  ['settings', '21-settings'],
];

for (const [route, name] of screens) {
  await page.goto(`${BASE}/#/${route}`);
  await page.waitForTimeout(900);
  await shot(name);
  const emptyOnly = await page.locator('.content .empty').count();
  const cards = await page.locator('.content .card, .content .kpi, .content .pos').count();
  if (!cards && emptyOnly === 0) errors.push(`[blank] ${route} rendered nothing`);
}

// Exercise the product details page, its editor, and the POS basket.
await page.goto(`${BASE}/#/products`);
await page.waitForTimeout(800);
await page.locator('table.data tbody tr').first().click();
await page.waitForTimeout(1500);
await shot('23-product-details');
const detailHash = await page.evaluate(() => location.hash);
if (!/#\/products\/\d+$/.test(detailHash)) errors.push(`[route] expected a product details route, got ${detailHash}`);
if (!(await page.locator('.kpis .kpi').count())) errors.push('[details] no KPIs rendered');
if (!(await page.locator('table.data').count())) errors.push('[details] no variant table rendered');

await page.goto(`${BASE}${detailHash}/edit`);
await page.waitForTimeout(1400);
await shot('23b-product-editor');
if (!(await page.locator('.attr-picker').count())) errors.push('[editor] variant matrix picker missing');

await page.goto(`${BASE}/#/pos`);
await page.waitForTimeout(700);
await page.fill('.pos-search input', 'tote');
await page.waitForTimeout(900);
if (await page.locator('.pos-result').count()) {
  await page.locator('.pos-result').first().click();
  await page.waitForTimeout(1000);
  await shot('24-pos-with-item');
}

// Arabic / RTL pass.
await page.evaluate(() => localStorage.setItem('mm.lang', 'ar'));
await page.goto(`${BASE}/#/dashboard`);
await page.reload();
await page.waitForSelector('.shell');
await page.waitForTimeout(1600);
const dir = await page.evaluate(() => document.documentElement.dir);
if (dir !== 'rtl') errors.push(`[rtl] expected dir=rtl, got ${dir}`);
await shot('25-dashboard-ar');
await page.goto(`${BASE}/#/pos`);
await page.waitForTimeout(1400);
await shot('26-pos-ar');
await page.goto(`${BASE}/#/products`);
await page.waitForTimeout(1400);
await shot('27-products-ar');
await page.evaluate(() => localStorage.setItem('mm.lang', 'en'));

await browser.close();

if (errors.length) {
  console.log('ERRORS:');
  console.log([...new Set(errors)].join('\n'));
  process.exit(1);
}
console.log('UI walkthrough clean — screenshots in', OUT);
