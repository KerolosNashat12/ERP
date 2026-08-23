/**
 * Walkthrough for round 7: صفحة فواتيرك, used the way the shop would use it.
 *
 * One invoice from the shop's supplier, photographed twice because the paper
 * runs to two pages, filed with the amount he could read off it. Then half of
 * it paid with the receipt photographed, and — the point of the whole page —
 * coming back later and paying the rest, reading what the screen says at each
 * step. Then a second invoice with no amount at all, because that is the case
 * the design turns on.
 *
 * And at every step, the thing that must not move: the shop's own profit, its
 * costs and its supplier balance are read before and after, and the check fails
 * if a single one of them changed.
 *
 * Development aid, not part of the shipped app or of `npm test`.
 *   MM_TEST_URL=http://127.0.0.1:4321 node tests/legacy-invoices-ui-check.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.MM_TEST_URL || 'http://127.0.0.1:4321';
const OUT = process.env.MM_SHOT_DIR || '/tmp/mm-legacy-invoice-shots';
fs.mkdirSync(OUT, { recursive: true });

const errors = [];
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const DESKTOP = { width: 1440, height: 980 };
const PHONE = { width: 390, height: 844 };
const page = await browser.newPage({ viewport: DESKTOP });

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
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  console.log('  shot', name);
};

async function setLanguage(lang) {
  await page.evaluate((value) => localStorage.setItem('mm.lang', value), lang);
  await page.reload();
  await page.waitForSelector('.shell', { timeout: 15000 });
  await page.waitForTimeout(1000);
}

/**
 * A page of a paper invoice, drawn in the browser and written out as a real
 * JPEG — the same trick `costs-ui-check.mjs` uses for the electricity bill.
 * Handwriting matters here: the whole reason the attachment ceiling is what it
 * is, is that a biro-written total has to stay readable.
 */
async function makeInvoicePage(target, { heading, lines, total }) {
  const dataUrl = await page.evaluate(({ heading: head, lines: rows, total: sum }) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1800; canvas.height = 2400;
    const c = canvas.getContext('2d');
    c.fillStyle = '#efe9dc'; c.fillRect(0, 0, 1800, 2400);
    c.fillStyle = '#fffdf7'; c.fillRect(120, 120, 1560, 2160);
    c.strokeStyle = '#bfae8c'; c.lineWidth = 5; c.strokeRect(120, 120, 1560, 2160);
    c.fillStyle = '#191919';
    c.font = 'bold 80px Georgia, serif';
    c.fillText(head, 190, 320);
    c.font = '48px Georgia, serif';
    rows.forEach((line, index) => c.fillText(line, 190, 470 + index * 90));
    if (sum) {
      c.font = 'italic 108px Georgia, serif';
      c.fillText(sum, 190, 470 + rows.length * 90 + 140);
    }
    c.strokeStyle = '#191919'; c.lineWidth = 7;
    c.beginPath(); c.moveTo(190, 1900); c.lineTo(880, 1840);
    c.lineTo(470, 1960); c.lineTo(1020, 1880); c.stroke();
    c.font = '40px Georgia, serif';
    c.fillText('supplier signature', 190, 2050);
    return canvas.toDataURL('image/jpeg', 0.95);
  }, { heading, lines, total });
  fs.writeFileSync(target, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('  fixture', target.split('/').pop(), `${Math.round(fs.statSync(target).size / 1024)} KB`);
}

const money = (text) => Number(String(text).replace(/[^\d.-]/g, ''));

/** The summary tiles on a screen, keyed by their lower-cased label. */
async function tiles() {
  return page.evaluate(() => Object.fromEntries(
    [...document.querySelectorAll('.kpis .kpi')].map((tile) => [
      tile.querySelector('.label').textContent.trim().toLowerCase(),
      tile.querySelector('.value').textContent.trim(),
    ]),
  ));
}

/**
 * The shop's OWN numbers — read straight off its API rather than off a screen,
 * because the question is whether the archive disturbed them and no screen can
 * answer that as precisely.
 */
async function shopTotals() {
  return page.evaluate(async () => {
    const get = async (url) => (await fetch(url, { credentials: 'same-origin' })).json();
    const [profit, costs, supplier] = await Promise.all([
      get('/api/reports/profit_and_costs?dateFrom=2000-01-01&dateTo=2100-01-01'),
      get('/api/costs/summary?dateFrom=2000-01-01&dateTo=2100-01-01'),
      get('/api/suppliers/1'),
    ]);
    return {
      profit: profit.summary,
      costs: { total: costs.total, entries: costs.entries },
      supplier: supplier.statistics,
    };
  });
}

// ------------------------------------------------------------------ sign in
await page.goto(BASE);
await page.waitForSelector('.login-card');
const NEW_PASSWORD = 'shopOwner!2026';

async function signIn() {
  for (const password of ['admin123', NEW_PASSWORD]) {
    await page.fill('input[name=username]', 'admin');
    await page.fill('input[name=password]', password);
    await page.click('button[type=submit]');
    try {
      await page.waitForSelector('.shell', { timeout: 8000 });
      return;
    } catch { await page.waitForTimeout(500); }
  }
  throw new Error('could not sign in with either password');
}
await signIn();
await page.waitForTimeout(1400);

if (await page.locator('.modal input[name=currentPassword]').count()) {
  await page.fill('.modal input[name=currentPassword]', 'admin123');
  await page.fill('.modal input[name=newPassword]', NEW_PASSWORD);
  await page.fill('.modal input[name=confirmPassword]', NEW_PASSWORD);
  await page.locator('.modal-foot button.primary, .modal button.primary').last().click();
  await page.waitForTimeout(2500);
  console.log('  default password changed');
}
if (await page.locator('.modal-backdrop').count()) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);
}

const pageOne = `${OUT}/invoice-page-1.jpg`;
const pageTwo = `${OUT}/invoice-page-2.jpg`;
await makeInvoicePage(pageOne, {
  heading: 'CAIRO LEATHER WORKS — INVOICE',
  lines: ['No. CL-2023-4471', 'Date 14/09/2023', '120 tote bags @ 55.00', '40 belts @ 30.00'],
  total: 'EGP 7,800.00',
});
await makeInvoicePage(pageTwo, {
  heading: 'CAIRO LEATHER WORKS — PAGE 2',
  lines: ['carried forward 7,800.00', 'delivery included', 'terms: on account'],
  total: null,
});
const receipt = `${OUT}/receipt.jpg`;
await makeInvoicePage(receipt, {
  heading: 'RECEIPT',
  lines: ['Received from M&M Accessories', 'against invoice CL-2023-4471'],
  total: 'EGP 3,900.00',
});

/**
 * One electricity bill on the costs page, so the "nothing moved" comparison
 * below is about a costs total that is a number rather than a zero. The demo
 * seed already supplies the sale, the purchase order and the supplier balance.
 */
await page.evaluate(async () => {
  const get = async (url) => (await fetch(url, { credentials: 'same-origin' })).json();
  const categories = await get('/api/cost-categories/options');
  const category = categories.rows.find((row) => row.kind !== 'salary');
  await fetch('/api/costs', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `ui-cost-${Date.now()}` },
    body: JSON.stringify({
      category_id: category.id, amount: 1180, spent_on: new Date().toISOString().slice(0, 10),
      description: 'Electricity', payment_method: 'cash',
    }),
  });
});

// ------------------------------------------------- the shop's own numbers, before
const before = await shopTotals();
console.log('  shop before:', JSON.stringify(before));

// ------------------------------------------------------------- the empty page
await page.goto(`${BASE}/#/legacy-invoices`);
await page.waitForTimeout(2000);
await shot('01-empty-en');

if (!(await page.locator('.callout').count())) {
  errors.push('[separation] the page carries no notice that it is outside the accounts');
}
const notice = await page.locator('.callout').first().textContent();
if (!/accounts/i.test(notice)) {
  errors.push(`[separation] the notice does not say what it must: ${notice}`);
}

// ------------------------------------------------- one invoice, two photographs
await page.locator('.page-head button.primary').click();
await page.waitForSelector('.modal');
await page.fill('.modal input[name=title]', 'Cairo Leather — autumn 2023');
await page.selectOption('.modal select[name=supplier_id]', { index: 0 });
await page.fill('.modal input[name=invoice_no]', 'CL-2023-4471');
await page.fill('.modal input[name=invoice_date]', '2023-09-14');
await page.fill('.modal input[name=total_amount]', '7800');
await page.fill('.modal textarea[name=notes]', 'Paid in two instalments — see the receipts');
await page.setInputFiles('.modal input[type=file]', pageOne);
// The browser rotates, scales and re-encodes before anything is sent.
await page.waitForTimeout(2500);
await page.locator('.modal button:has-text("Add another page")').first().click();
await page.waitForTimeout(400);
await page.locator('.modal input[type=file]').last().setInputFiles(pageTwo);
await page.waitForTimeout(2500);
await shot('02-filing-two-pages-en');
await page.locator('.modal-foot button.primary').click();
await page.waitForTimeout(2600);
await shot('03-filed-unpaid-en');

const afterFiling = await tiles();
console.log('  tiles after filing:', JSON.stringify(afterFiling));
const thumbs = await page.locator('table.data .proof-thumb').count();
if (thumbs !== 2) errors.push(`[photos] expected two thumbnails on the row, saw ${thumbs}`);
if (!(await page.locator('table.data .tag').filter({ hasText: /Not paid/i }).count())) {
  errors.push('[status] a filed invoice with nothing paid should read "Not paid"');
}

// ----------------------------------------------------------- pay half of it
await page.locator('table.data button:has-text("Payments on this invoice")').first().click();
await page.waitForSelector('.modal');
await page.waitForTimeout(1800);
await shot('04-invoice-open-en');

await page.locator('.modal button:has-text("Register payment")').first().click();
await page.waitForTimeout(900);
const payDialog = () => page.locator('.modal-backdrop').last();
await payDialog().locator('input[name=amount]').fill('3900');
await payDialog().locator('input[name=paidOn]').fill('2023-10-02');
await payDialog().locator('select[name=method]').selectOption('cash');
await payDialog().locator('input[name=reference]').fill('CASH-1102');
await payDialog().locator('input[type=file]').setInputFiles(receipt);
await page.waitForTimeout(2500);
await shot('05-paying-half-en');
await payDialog().locator('.modal-foot button.primary').click();
await page.waitForTimeout(2800);
await shot('06-part-paid-en');

const partText = await page.locator('.modal-backdrop').last().textContent();
if (!/Part paid/i.test(partText)) errors.push('[status] after half was paid the invoice should read "Part paid"');
if (!/3,?900/.test(partText)) errors.push('[status] the remaining 3,900 is not on the screen');

// ------------------------------------------------- come back and pay the rest
await page.keyboard.press('Escape');
await page.waitForTimeout(700);
await page.goto(`${BASE}/#/legacy-invoices`);
await page.waitForTimeout(2200);
await shot('07-list-part-paid-en');

await page.locator('table.data button:has-text("Payments on this invoice")').first().click();
await page.waitForSelector('.modal');
await page.waitForTimeout(1600);
await page.locator('.modal button:has-text("Register payment")').first().click();
await page.waitForTimeout(900);
// The rest is offered as the default — this is the "ادفع الباقي" case.
const offered = await payDialog().locator('input[name=amount]').inputValue();
if (Number(offered) !== 3900) errors.push(`[payment] the rest should be offered, saw "${offered}"`);
await payDialog().locator('input[name=paidOn]').fill('2023-11-20');
await payDialog().locator('select[name=method]').selectOption('transfer');
await shot('08-paying-rest-en');
await payDialog().locator('.modal-foot button.primary').click();
await page.waitForTimeout(2800);
await shot('09-settled-en');

const settledText = await page.locator('.modal-backdrop').last().textContent();
if (!/Paid in full/i.test(settledText)) errors.push('[status] the settled invoice should read "Paid in full"');
await page.keyboard.press('Escape');
await page.waitForTimeout(700);

// -------------------------------------- an invoice he cannot read the amount of
await page.goto(`${BASE}/#/legacy-invoices`);
await page.waitForTimeout(1800);
await page.locator('.page-head button.primary').click();
await page.waitForSelector('.modal');
await page.fill('.modal input[name=title]', 'Faded receipt — cannot read the total');
await page.selectOption('.modal select[name=supplier_id]', { index: 0 });
await page.fill('.modal input[name=invoice_date]', '2022-06-30');
await page.setInputFiles('.modal input[type=file]', pageTwo);
await page.waitForTimeout(2500);
await shot('10-no-amount-dialog-en');
await page.locator('.modal-foot button.primary').click();
await page.waitForTimeout(2600);
await shot('11-list-with-unknown-en');

const listText = await page.locator('table.data').textContent();
if (!/No amount yet/i.test(listText)) {
  errors.push('[status] an invoice with no amount should say so rather than showing a zero');
}

const finalTiles = await tiles();
console.log('  tiles at the end:', JSON.stringify(finalTiles));
const stillOwed = money(finalTiles['still owed on paper']);
if (stillOwed !== 0) errors.push(`[tiles] everything with an amount is settled, so nothing is owed — saw ${stillOwed}`);
const archiveTotal = money(finalTiles['what they came to']);
if (archiveTotal !== 7800) errors.push(`[tiles] the archive should come to 7,800 — saw ${archiveTotal}`);

// ------------------------------------------- the thing that must not have moved
const after = await shopTotals();
console.log('  shop after: ', JSON.stringify(after));
if (JSON.stringify(after) !== JSON.stringify(before)) {
  errors.push('[SEPARATION] a shop total moved because of the archive — this is the whole feature');
  console.error('    before', JSON.stringify(before));
  console.error('    after ', JSON.stringify(after));
}

// The costs page and the profit report, photographed so a human can see for
// himself that 7,800 is nowhere on them.
await page.goto(`${BASE}/#/costs`);
await page.waitForTimeout(2200);
await shot('12-costs-unchanged-en');
await page.goto(`${BASE}/#/reports/profit_and_costs`);
await page.waitForTimeout(2600);
await shot('13-profit-unchanged-en');

// ------------------------------------------------------------ Arabic, desktop
await setLanguage('ar');
const dir = await page.evaluate(() => document.documentElement.dir);
if (dir !== 'rtl') errors.push(`[rtl] expected dir=rtl, got ${dir}`);

await page.goto(`${BASE}/#/legacy-invoices`);
await page.waitForTimeout(2200);
await shot('20-list-ar');

const arabicNotice = await page.locator('.callout').first().textContent();
if (!/حسابات المحل/.test(arabicNotice)) {
  errors.push('[separation] the Arabic notice does not name the shop’s accounts');
}
if (/[A-Za-z]{4,}/.test(await page.locator('.page-head').textContent())) {
  errors.push('[i18n] English words are left in the Arabic page heading');
}

await page.locator('table.data button').first().click();
await page.waitForSelector('.modal');
await page.waitForTimeout(1800);
await shot('21-invoice-open-ar');
await page.keyboard.press('Escape');
await page.waitForTimeout(600);

await page.locator('.page-head button.primary').click();
await page.waitForSelector('.modal');
await page.waitForTimeout(900);
await shot('22-filing-dialog-ar');
await page.keyboard.press('Escape');
await page.waitForTimeout(600);

// --------------------------------------------------------------- 390px, both
await page.setViewportSize(PHONE);
await page.goto(`${BASE}/#/legacy-invoices`);
await page.waitForTimeout(2000);
await shot('30-list-390-ar');
await page.locator('table.data button').first().click();
await page.waitForSelector('.modal');
await page.waitForTimeout(1800);
await shot('31-invoice-390-ar');

/*
 * The dialog is where this page is actually used, so it is the thing that has
 * to survive a phone. A modal that is wider than the screen loses its left-hand
 * side in Arabic and nothing about that is recoverable by scrolling the page.
 */
const modalWidth = await page.evaluate(() => {
  const dialog = document.querySelector('.modal');
  return { modal: dialog ? dialog.getBoundingClientRect().width : 0, win: window.innerWidth };
});
if (modalWidth.modal > modalWidth.win + 2) {
  errors.push(`[responsive] the invoice dialog is wider than the phone (${modalWidth.modal} > ${modalWidth.win})`);
}

await page.keyboard.press('Escape');
await page.waitForTimeout(600);

const overflowAr = await page.evaluate(() => ({
  doc: document.documentElement.scrollWidth, win: window.innerWidth,
}));
if (overflowAr.doc > overflowAr.win + 2) {
  errors.push(`[responsive] the Arabic page scrolls sideways at 390px (${overflowAr.doc} > ${overflowAr.win})`);
}

await setLanguage('en');
await page.goto(`${BASE}/#/legacy-invoices`);
await page.waitForTimeout(2000);
await shot('32-list-390-en');
await page.locator('.page-head button.primary').click();
await page.waitForSelector('.modal');
await page.waitForTimeout(900);
await shot('33-filing-390-en');
await page.keyboard.press('Escape');
await page.waitForTimeout(600);

const overflowEn = await page.evaluate(() => ({
  doc: document.documentElement.scrollWidth, win: window.innerWidth,
}));
if (overflowEn.doc > overflowEn.win + 2) {
  errors.push(`[responsive] the English page scrolls sideways at 390px (${overflowEn.doc} > ${overflowEn.win})`);
}

// The sidebar, so the new entry can be seen where the owner asked for it —
// beside الموردون and أوامر الشراء.
await page.setViewportSize(DESKTOP);
await setLanguage('ar');
await page.goto(`${BASE}/#/legacy-invoices`);
await page.waitForTimeout(1800);
await shot('34-sidebar-ar');

await browser.close();

if (errors.length) {
  console.error(`\n${errors.length} problem(s):`);
  for (const error of errors) console.error('  ' + error);
  process.exitCode = 1;
} else {
  console.log('\nno console errors, the status followed the payments, and not one shop total moved');
}
console.log('screenshots in', OUT);
