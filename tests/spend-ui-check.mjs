/**
 * The two lifetime reports, looked at the way the owner will look at them.
 *
 * A shop with two years in it, opened on "كل مصاريف المحل" and on "الأرباح بعد
 * التكاليف", in both languages, on a desktop and on a 390px phone. It checks
 * the three things a screenshot cannot: that the headline tile is the sum of
 * the rows underneath it, that the report says out loud what it cannot see,
 * and that the export downloads with the Arabic words in it.
 *
 * Development aid, not part of the shipped app or of `npm test`.
 *   MM_TEST_URL=http://127.0.0.1:4321 node tests/spend-ui-check.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.MM_TEST_URL || 'http://127.0.0.1:4321';
const OUT = process.env.MM_SHOT_DIR || '/tmp/mm-spend-shots';
fs.mkdirSync(OUT, { recursive: true });

const errors = [];
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const DESKTOP = { width: 1440, height: 980 };
const PHONE = { width: 390, height: 844 };
const page = await browser.newPage({ viewport: DESKTOP, acceptDownloads: true });

/** The pre-login /auth/me probe answers 401 by design; nothing else is expected. */
const EXPECTED = [/\b401\b/];
page.on('console', (msg) => {
  if (msg.type() !== 'error') return;
  const text = msg.text();
  if (EXPECTED.some((p) => p.test(text))) return;
  errors.push(`[console] ${text} @ ${page.url()}`);
});
page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));

const shot = async (name) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  console.log('  shot', name);
};

async function setLanguage(lang) {
  await page.evaluate((value) => localStorage.setItem('mm.lang', value), lang);
  await page.reload();
  await page.waitForSelector('.shell', { timeout: 15000 });
  await page.waitForTimeout(900);
}

const money = (text) => Number(String(text).replace(/[^\d.-]/g, ''));

async function tiles() {
  return page.evaluate(() => Object.fromEntries(
    [...document.querySelectorAll('.kpis .kpi')].map((tile) => [
      tile.querySelector('.label').textContent.trim().toLowerCase(),
      tile.querySelector('.value').textContent.trim(),
    ]),
  ));
}

/**
 * How long the screen took between asking for a report and drawing its rows.
 *
 * The layout already on screen is marked stale first, because the previous
 * report's table is still in the document the instant the hash changes: a
 * check that only waited for "a row exists" would read the report it just
 * navigated away from and believe it.
 */
async function openReport(key) {
  // Navigating to the hash the page is already on is not a navigation, so the
  // screen would never re-render and the wait below would never finish.
  if (page.url().endsWith(`#/reports/${key}`)) {
    await page.goto(`${BASE}/#/dashboard`);
    await page.waitForTimeout(400);
  }
  await page.evaluate(() => document.querySelector('.report-layout')?.setAttribute('data-stale', '1'));
  const started = Date.now();
  await page.goto(`${BASE}/#/reports/${key}`);
  await page.waitForFunction(() => {
    const layout = document.querySelector('.report-layout:not([data-stale])');
    return layout !== null && layout.querySelector('table.data tbody tr, .empty') !== null;
  }, { timeout: 20000 });
  return Date.now() - started;
}

// ------------------------------------------------------------------ sign in
await page.goto(BASE);
await page.waitForSelector('.login-card');
const NEW_PASSWORD = 'shopOwner!2026';
for (const password of ['admin123', NEW_PASSWORD]) {
  await page.fill('input[name=username]', 'admin');
  await page.fill('input[name=password]', password);
  await page.click('button[type=submit]');
  try { await page.waitForSelector('.shell', { timeout: 8000 }); break; } catch { /* try the other */ }
}
await page.waitForTimeout(1200);
if (await page.locator('.modal input[name=currentPassword]').count()) {
  await page.fill('.modal input[name=currentPassword]', 'admin123');
  await page.fill('.modal input[name=newPassword]', NEW_PASSWORD);
  await page.fill('.modal input[name=confirmPassword]', NEW_PASSWORD);
  await page.locator('.modal-foot button.primary, .modal button.primary').last().click();
  await page.waitForTimeout(2000);
}
if (await page.locator('.modal-backdrop').count()) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);
}

// ----------------------------------------------------- English, desktop
await setLanguage('en');
const spendMs = await openReport('shop_spend');
console.log(`  shop_spend opened in ${spendMs}ms`);
await shot('01-spend-en');

const spendTiles = await tiles();
console.log('  spend tiles:', JSON.stringify(spendTiles));
const headline = money(spendTiles['money out of the shop']);
if (!headline) errors.push('[spend] no headline tile');

// The headline must be the rows. A total the owner cannot reconcile against
// what is underneath it is the total he will stop believing first.
const rowSum = await page.evaluate(() => [...document.querySelectorAll('table.data tbody tr')]
  .map((tr) => Number(tr.children[3].textContent.replace(/[^\d.-]/g, '')))
  .reduce((a, b) => a + b, 0));
if (Math.abs(rowSum - headline) > 0.05) {
  errors.push(`[spend] the rows add up to ${rowSum}, the headline says ${headline}`);
} else {
  console.log(`  headline ${headline} == rows ${rowSum.toFixed(2)}`);
}

// It has to open on the whole history, not on this month.
const dates = await page.evaluate(() => [...document.querySelectorAll('.filters input[type=date]')]
  .map((input) => input.value));
if (dates.some(Boolean)) errors.push(`[spend] opened on a date window ${JSON.stringify(dates)}`);

const blind = await page.locator('.callout.blind').count();
if (!blind) errors.push('[spend] the report does not say what it cannot see');
else console.log('  blind-spot callout lines:',
  await page.locator('.callout.blind p').count());

const profitMs = await openReport('profit_and_costs');
console.log(`  profit_and_costs opened in ${profitMs}ms`);
await shot('02-profit-en');
const profitTiles = await tiles();
console.log('  profit tiles:', JSON.stringify(profitTiles));
if (!(await page.locator('.callout.blind').count())) {
  errors.push('[profit] the report does not say what it cannot see');
}
// The two reports must agree on the money that is in both of them.
const costsPaid = money(spendTiles['shop costs paid']) + money(spendTiles['wages paid']);
const profitCosts = money(profitTiles.costs);
if (Math.abs(costsPaid - profitCosts) > 0.05) {
  errors.push(`[agree] spend says ${costsPaid} of costs+wages, profit says ${profitCosts}`);
} else {
  console.log(`  the two reports agree on costs: ${profitCosts}`);
}

// A header that still says the columns it used to say, plus the new ones.
const heads = await page.locator('table.data thead th').allTextContents();
console.log('  profit columns:', heads.join(' | '));

// The printable sheet. It is built from the same report object and has to
// carry the blind spots too — a total handed to an accountant on paper
// outlives the screen it came from.
await page.evaluate(() => { window.print = () => {}; });
await page.locator('.page-head button:has-text("Print")').click();
await page.waitForTimeout(400);
const printed = await page.evaluate(() => {
  const root = document.getElementById('print-root');
  return {
    rows: root.querySelectorAll('table tbody tr').length,
    totals: root.querySelectorAll('.doc-totals .line').length,
    blind: root.querySelectorAll('.callout.blind p').length,
  };
});
console.log('  print sheet:', JSON.stringify(printed));
if (!printed.rows || !printed.totals) errors.push('[print] the printable sheet is empty');
if (!printed.blind) errors.push('[print] the printed sheet does not carry the blind spots');

// ------------------------------------------------------------- the export
await page.goto(`${BASE}/#/reports/shop_spend`);
await page.waitForTimeout(1500);
const download = await Promise.all([
  page.waitForEvent('download', { timeout: 15000 }),
  page.locator('.page-head button:has-text("Export")').click(),
]).then(([d]) => d).catch((error) => { errors.push(`[export] ${error.message}`); return null; });
if (download) {
  const target = `${OUT}/shop_spend-en.csv`;
  await download.saveAs(target);
  const csv = fs.readFileSync(target, 'utf8');
  const lines = csv.trim().split('\n');
  console.log(`  exported ${lines.length - 1} rows, header: ${lines[0].replace(/^﻿/, '')}`);
  if (!/Where it went/.test(lines[0])) errors.push('[export] the English CSV is not the English report');
}

// ------------------------------------------------------- Arabic, desktop
await setLanguage('ar');
if ((await page.evaluate(() => document.documentElement.dir)) !== 'rtl') {
  errors.push('[rtl] the Arabic screen is not right-to-left');
}
await openReport('shop_spend');
await shot('03-spend-ar');
const arTiles = await tiles();
console.log('  spend tiles (ar):', JSON.stringify(arTiles));
if (!Object.keys(arTiles).some((label) => /[؀-ۿ]/.test(label))) {
  errors.push('[i18n] the summary tiles are still in English on the Arabic screen');
}
const arFirstCell = await page.locator('table.data tbody tr:first-child td:first-child').textContent();
if (!/[؀-ۿ]/.test(arFirstCell)) {
  errors.push(`[i18n] the first column reads "${arFirstCell}" on the Arabic screen`);
} else {
  console.log('  first Arabic cell:', arFirstCell.trim());
}
const arNote = await page.locator('.callout.blind p').first().textContent();
if (!/[؀-ۿ]/.test(arNote)) errors.push('[i18n] the blind-spot callout is in English');

await openReport('profit_and_costs');
await shot('04-profit-ar');

// The Arabic export.
const arDownload = await Promise.all([
  page.waitForEvent('download', { timeout: 15000 }),
  page.locator('.page-head button').filter({ hasText: '⭳' }).click(),
]).then(([d]) => d).catch((error) => { errors.push(`[export-ar] ${error.message}`); return null; });
if (arDownload) {
  const target = `${OUT}/profit-ar.csv`;
  await arDownload.saveAs(target);
  const csv = fs.readFileSync(target, 'utf8');
  if (csv.charCodeAt(0) !== 0xFEFF) errors.push('[export-ar] no BOM — Excel will mangle the Arabic');
  if (!/[؀-ۿ]/.test(csv.split('\n')[0])) errors.push('[export-ar] the header is not Arabic');
  console.log('  arabic CSV header:', csv.split('\n')[0].replace(/^﻿/, ''));
}

// --------------------------------------------------------------- 390px
await page.setViewportSize(PHONE);
await openReport('shop_spend');
await shot('05-spend-390-ar');
await openReport('profit_and_costs');
await shot('06-profit-390-ar');
await setLanguage('en');
await openReport('shop_spend');
await shot('07-spend-390-en');
await openReport('profit_and_costs');
await shot('08-profit-390-en');

const overflow = await page.evaluate(() => ({
  doc: document.documentElement.scrollWidth, win: window.innerWidth,
}));
if (overflow.doc > overflow.win + 2) {
  errors.push(`[responsive] the page scrolls sideways at 390px (${overflow.doc} > ${overflow.win})`);
}

// The report that was renamed last round still carries its note, and the
// sidebar still lists everything it listed.
await page.setViewportSize(DESKTOP);
await openReport('sales_summary');
const keptItsNote = await page.locator('.callout').first().waitFor({ timeout: 5000 })
  .then(() => true).catch(() => false);
if (!keptItsNote) errors.push('[note] the sales summary lost its note');
await shot('09-sales-summary-en');
const catalogue = await page.locator('.report-layout .card button').allTextContents();
console.log(`  ${catalogue.length} reports in the catalogue`);

await browser.close();
if (errors.length) {
  console.error(`\n${errors.length} problem(s):`);
  for (const error of errors) console.error('  ' + error);
  process.exitCode = 1;
} else {
  console.log('\nno console errors, the headline is the rows, the two reports agree, and both exports work');
}
console.log('screenshots in', OUT);
