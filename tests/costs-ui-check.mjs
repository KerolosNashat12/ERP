/**
 * Walkthrough for round 6: التكاليف and المرتبات, used the way a shop would.
 *
 * Three costs of different kinds — one typed, one repeating, one with a
 * photograph of the bill — two employees on different periods, one of them
 * paid, and then the profit report, to check that the number moved by exactly
 * what was spent and not by a penny more.
 *
 * Development aid, not part of the shipped app or of `npm test`.
 *   MM_TEST_URL=http://127.0.0.1:4321 node tests/costs-ui-check.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.MM_TEST_URL || 'http://127.0.0.1:4321';
const OUT = process.env.MM_SHOT_DIR || '/tmp/mm-costs-shots';
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

/** An electricity bill, drawn in the browser and written out as a real JPEG. */
async function makeBillFile(target) {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 2000; canvas.height = 2600;
    const c = canvas.getContext('2d');
    c.fillStyle = '#f2efe6'; c.fillRect(0, 0, 2000, 2600);
    c.fillStyle = '#fffefa'; c.fillRect(160, 160, 1680, 2280);
    c.strokeStyle = '#c8bfa6'; c.lineWidth = 6; c.strokeRect(160, 160, 1680, 2280);
    c.fillStyle = '#1d1d1d';
    c.font = 'bold 92px Georgia, serif';
    c.fillText('SOUTH CAIRO ELECTRICITY', 240, 380);
    c.font = '58px Georgia, serif';
    c.fillText('Meter 55-88231  ·  March 2026', 240, 500);
    c.fillText('Consumption 412 kWh', 240, 600);
    c.font = 'italic 130px Georgia, serif';
    c.fillText('EGP 1,180.00', 240, 900);
    c.font = '54px Georgia, serif';
    c.fillText('Paid at the office, 18/03/2026', 240, 1040);
    c.strokeStyle = '#1d1d1d'; c.lineWidth = 8;
    c.beginPath(); c.moveTo(240, 1300); c.lineTo(1000, 1240);
    c.lineTo(560, 1360); c.lineTo(1160, 1280); c.stroke();
    c.font = '44px Georgia, serif';
    c.fillText('cashier signature', 240, 1460);
    return canvas.toDataURL('image/jpeg', 0.95);
  });
  fs.writeFileSync(target, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('  bill fixture', `${Math.round(fs.statSync(target).size / 1024)} KB`);
}

const money = (text) => Number(String(text).replace(/[^\d.-]/g, ''));

/**
 * Dates inside the window the screens open on.
 *
 * The costs ledger and the profit report both default to "this month so far",
 * which is the right default for a shop and the wrong one for a walkthrough
 * that hard-codes March: the costs would be filed correctly, land outside every
 * default filter, and the check would read zero and call it a bug. So the whole
 * walkthrough is dated into the current month.
 */
const TODAY = new Date().toISOString().slice(0, 10);
const MONTH = TODAY.slice(0, 7);
const day = (n) => `${MONTH}-${String(n).padStart(2, '0')}`;

/**
 * The summary tiles on the report screen, keyed by their lower-cased label.
 *
 * Lower-cased because the labels are translated now — "Gross profit" rather
 * than the raw `gross profit` key this used to read — and a walkthrough that
 * matched the old casing would silently find nothing and report a zero as if
 * the feature were broken.
 */
async function reportSummary() {
  return page.evaluate(() => Object.fromEntries(
    [...document.querySelectorAll('.kpis .kpi')].map((tile) => [
      tile.querySelector('.label').textContent.trim().toLowerCase(),
      tile.querySelector('.value').textContent.trim(),
    ]),
  ));
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

const bill = `${OUT}/bill-fixture.jpg`;
await makeBillFile(bill);

// ------------------------------------------------- the profit report, before
await page.goto(`${BASE}/#/reports/profit_and_costs`);
await page.waitForTimeout(2500);
const before = await reportSummary();
console.log('  profit before:', JSON.stringify(before));
await shot('00-profit-before-en');

// ------------------------------------------------------------- three costs
await page.goto(`${BASE}/#/costs`);
await page.waitForTimeout(1800);
await shot('01-costs-empty-en');

/** Fill the cost dialog and save. */
async function addCost({ category, amount, date, description, reference, file = null }) {
  await page.locator('.page-head button.primary').click();
  await page.waitForSelector('.modal');
  await page.selectOption('.modal select[name=category_id]', { label: category });
  await page.fill('.modal input[name=amount]', String(amount));
  await page.fill('.modal input[name=spent_on]', date);
  await page.fill('.modal input[name=description]', description);
  if (reference) await page.fill('.modal input[name=reference]', reference);
  if (file) {
    await page.setInputFiles('.modal input[type=file]', file);
    // The browser rotates, scales and re-encodes before anything is sent.
    await page.waitForTimeout(2500);
    await shot('02-cost-dialog-photo-en');
  }
  await page.locator('.modal-foot button.primary').click();
  await page.waitForTimeout(2200);
}

await addCost({
  category: 'Taxes', amount: 2500, date: day(12),
  description: 'Quarterly shop tax', reference: 'TAX-Q1',
});
await addCost({
  category: 'Maintenance', amount: 640.5, date: day(14),
  description: 'Air conditioner service',
});
await addCost({
  category: 'Electricity', amount: 1180, date: day(18),
  description: 'Electricity bill', reference: '55-88231', file: bill,
});

// ------------------------------------------------------- one that repeats
await page.locator('button:has-text("Repeating costs")').first().click();
await page.waitForTimeout(1200);
await page.locator('.page-head button.primary').click();
await page.waitForSelector('.modal');
await page.selectOption('.modal select[name=category_id]', { label: 'Rent' });
await page.fill('.modal input[name=amount]', '4000');
await page.fill('.modal input[name=day_of_month]', '5');
// Dated at the 5th of this month, so exactly one month is owed: enough to see
// the confirmation flow without a walkthrough that posts six months of rent.
await page.fill('.modal input[name=starts_on]', day(5));
await page.fill('.modal input[name=description]', 'Shop rent — Giza');
await shot('03-repeating-dialog-en');
await page.locator('.modal-foot button.primary').click();
await page.waitForTimeout(2200);
await shot('04-repeating-list-en');

// Back to the ledger: the months it owes are waiting, unposted.
await page.locator('.row button:has-text("Costs")').first().click();
await page.waitForTimeout(1500);
const waiting = await page.locator('.card:has-text("waiting") table.data tbody tr').count();
console.log('  repeating months waiting:', waiting);
if (waiting !== 1) {
  errors.push(`[recurring] expected exactly one month waiting, saw ${waiting}`);
}
await shot('05-costs-waiting-en');

await page.locator('button:has-text("Confirm all")').first().click();
await page.waitForTimeout(2500);
await shot('06-costs-ledger-en');

// The photograph, opened.
if (!(await page.locator('.proof-thumb').count())) {
  errors.push('[proof] no thumbnail on the costs ledger');
} else {
  await page.locator('.proof-thumb').first().click();
  await page.waitForSelector('.proof-full');
  await page.waitForTimeout(1200);
  const shown = await page.locator('.proof-full').evaluate((img) => ({ w: img.naturalWidth }));
  if (!shown.w) errors.push('[proof] the full photograph did not load');
  console.log('  opened bill photograph', JSON.stringify(shown));
  await shot('07-bill-opened-en');
  await page.locator('.modal-head button').click();
  await page.waitForTimeout(500);
}

const costsTotal = money(await page.locator('.kpi .value').first().textContent());
console.log('  costs total on screen:', costsTotal);

// ------------------------------------------------------------- two employees
await page.goto(`${BASE}/#/employees`);
await page.waitForTimeout(1600);
await shot('08-employees-empty-en');

async function addEmployee({ name, job, phone, amount, period, hired }) {
  await page.locator('.page-head button.primary').click();
  await page.waitForSelector('.modal');
  await page.fill('.modal input[name=name]', name);
  await page.fill('.modal input[name=job_title]', job);
  await page.fill('.modal input[name=phone]', phone);
  await page.fill('.modal input[name=salary_amount]', String(amount));
  await page.selectOption('.modal select[name=salary_period]', period);
  await page.fill('.modal input[name=hired_on]', hired);
  await page.locator('.modal-foot button.primary').click();
  await page.waitForTimeout(2000);
}

await addEmployee({
  name: 'Mahmoud Sayed', job: 'Delivery', phone: '01001234567',
  amount: 250, period: 'week', hired: day(1),
});
await addEmployee({
  name: 'Hoda Kamal', job: 'Shop assistant', phone: '01119876543',
  amount: 4500, period: 'month', hired: day(1),
});
await shot('09-employees-list-en');

// ------------------------------------------------------------ pay one of them
await page.locator('tr:has-text("Mahmoud Sayed") button:has-text("Record a payment")').first().click();
await page.waitForSelector('.modal');
await page.fill('.modal input[name=amount]', '250');
await page.fill('.modal input[name=paid_on]', day(20) <= TODAY ? day(20) : TODAY);
await shot('10-pay-salary-en');
await page.locator('.modal-foot button.primary').click();
await page.waitForTimeout(2500);
await shot('11-employees-after-payment-en');

// One person's history.
await page.locator('tr:has-text("Mahmoud Sayed")').first().click();
await page.waitForSelector('.modal');
await page.waitForTimeout(1600);
await shot('12-employee-history-en');
await page.locator('.modal-head button').click();
await page.waitForTimeout(600);

// ------------------------------------------------- the profit report, after
await page.goto(`${BASE}/#/reports/profit_and_costs`);
await page.waitForTimeout(2600);
const after = await reportSummary();
console.log('  profit after:', JSON.stringify(after));
await shot('13-profit-after-en');

const spent = 2500 + 640.5 + 1180 + 4000 + 250; // three costs, one rent, one salary
const grossBefore = money(before['gross profit']);
const grossAfter = money(after['gross profit']);
const netBefore = money(before['net profit']);
const netAfter = money(after['net profit']);
const costsAfter = money(after.costs);

console.log(`  spent ${spent} · costs report ${costsAfter} · net ${netBefore} -> ${netAfter}`);
if (Math.abs(costsAfter - spent) > 0.005) {
  errors.push(`[profit] costs read ${costsAfter}, expected exactly ${spent}`);
}
if (Math.abs((netBefore - netAfter) - spent) > 0.005) {
  errors.push(`[profit] net profit moved by ${netBefore - netAfter}, expected exactly ${spent}`);
}
if (Math.abs(grossBefore - grossAfter) > 0.005) {
  errors.push(`[profit] gross profit moved from ${grossBefore} to ${grossAfter} — it must not have`);
}

// The old report, and how a reader finds out it changed.
await page.goto(`${BASE}/#/reports/sales_summary`);
await page.waitForTimeout(2200);
if (!(await page.locator('.callout').count())) errors.push('[note] the sales summary carries no note');
const heading = await page.locator('table.data thead th').allTextContents();
if (!heading.some((h) => /before costs/i.test(h))) {
  errors.push('[note] the profit column was not renamed');
}
await shot('14-sales-summary-note-en');

// The dashboard's two profits.
await page.goto(`${BASE}/#/dashboard`);
await page.waitForTimeout(2200);
await shot('15-dashboard-en');

// ------------------------------------------------------- Arabic, desktop
await setLanguage('ar');
const dir = await page.evaluate(() => document.documentElement.dir);
if (dir !== 'rtl') errors.push(`[rtl] expected dir=rtl, got ${dir}`);

const arabicScreens = [
  ['costs', '20-costs-ar'],
  ['costs/repeating', '21-repeating-ar'],
  ['employees', '22-employees-ar'],
  ['cost-categories', '23-categories-ar'],
  ['reports/profit_and_costs', '24-profit-ar'],
  ['reports/sales_summary', '25-sales-summary-note-ar'],
  ['dashboard', '26-dashboard-ar'],
];
for (const [route, name] of arabicScreens) {
  await page.goto(`${BASE}/#/${route}`);
  await page.waitForTimeout(1800);
  await shot(name);
}

// The Arabic dialogs, which is where most of the new strings live.
await page.goto(`${BASE}/#/costs`);
await page.waitForTimeout(1600);
await page.locator('.page-head button.primary').click();
await page.waitForSelector('.modal');
await page.waitForTimeout(700);
await shot('27-cost-dialog-ar');
await page.keyboard.press('Escape');
await page.waitForTimeout(500);

await page.goto(`${BASE}/#/employees`);
await page.waitForTimeout(1600);
await page.locator('tr:has-text("Mahmoud Sayed") button.primary').first().click();
await page.waitForSelector('.modal');
await page.waitForTimeout(800);
await shot('28-pay-salary-ar');
await page.keyboard.press('Escape');
await page.waitForTimeout(500);

await page.locator('tr:has-text("Mahmoud Sayed")').first().click();
await page.waitForSelector('.modal');
await page.waitForTimeout(1600);
await shot('29-employee-history-ar');
await page.keyboard.press('Escape');
await page.waitForTimeout(500);

// --------------------------------------------------------------- 390px, both
await page.setViewportSize(PHONE);
const phoneScreens = [
  ['costs', '30-costs-390-ar'],
  ['costs/repeating', '31-repeating-390-ar'],
  ['employees', '32-employees-390-ar'],
  ['reports/profit_and_costs', '33-profit-390-ar'],
];
for (const [route, name] of phoneScreens) {
  await page.goto(`${BASE}/#/${route}`);
  await page.waitForTimeout(1700);
  await shot(name);
}

await setLanguage('en');
const phoneScreensEn = [
  ['costs', '34-costs-390-en'],
  ['costs/repeating', '35-repeating-390-en'],
  ['employees', '36-employees-390-en'],
  ['cost-categories', '37-categories-390-en'],
  ['reports/profit_and_costs', '38-profit-390-en'],
];
for (const [route, name] of phoneScreensEn) {
  await page.goto(`${BASE}/#/${route}`);
  await page.waitForTimeout(1700);
  await shot(name);
}

// A page that scrolls sideways on a phone is a page nobody can use.
const overflow = await page.evaluate(() => ({
  doc: document.documentElement.scrollWidth,
  win: window.innerWidth,
}));
if (overflow.doc > overflow.win + 2) {
  errors.push(`[responsive] the page scrolls sideways at 390px (${overflow.doc} > ${overflow.win})`);
}

// The desktop English category screen, for completeness.
await page.setViewportSize(DESKTOP);
await page.goto(`${BASE}/#/cost-categories`);
await page.waitForTimeout(1800);
await shot('39-categories-en');

await browser.close();

if (errors.length) {
  console.error(`\n${errors.length} problem(s):`);
  for (const error of errors) console.error('  ' + error);
  process.exitCode = 1;
} else {
  console.log('\nno console errors, no blank screens, and profit moved by exactly what was spent');
}
console.log('screenshots in', OUT);
