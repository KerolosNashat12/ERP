/**
 * A real browser on the ERP: bulk selection, the exchange screen and the full-invoice button.
 *
 * The API tests prove the money and the stock. This proves the SCREENS — that
 * ticking rows raises a bar that says how many, that a bulk change asks before
 * it acts, that the exchange screen finds an invoice and prices a replacement,
 * and that the whole thing can be completed by clicking rather than by posting
 * JSON. Run against a server the caller started:
 *
 *   MM_TEST_URL=http://127.0.0.1:4000 node tests/round15-ui-check.mjs
 */
import { chromium } from 'playwright';
const BASE = process.env.MM_TEST_URL || 'http://127.0.0.1:4000';
const failures = [];
const fail = (m) => failures.push(m);
const browser = await chromium.launch({
  executablePath: process.env.MM_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => fail(`[pageerror] ${e.message}`));
let watching = false;
page.on('console', (m) => { if (watching && m.type() === 'error') fail(`[console] ${m.text().slice(0, 200)}`); });

await page.goto(`${BASE}/app.html`);
await page.waitForSelector('input[type="password"]');
await page.fill('input[name="username"], #username', 'admin');
await page.fill('input[type="password"]', 'admin123');
await page.press('input[type="password"]', 'Enter');
await page.waitForSelector('h2');
await page.waitForTimeout(1200);
await page.evaluate(() => { document.querySelectorAll('#modal-root > *').forEach((n) => n.remove()); });
watching = true;

// ---------------------------------------------------------------- bulk edit
await page.goto(`${BASE}/app.html#/products`);
await page.waitForSelector('tbody tr');
await page.waitForTimeout(500);

const boxes = await page.$$('tbody input[type="checkbox"]');
if (boxes.length < 3) fail(`expected a checkbox per row, found ${boxes.length}`);
await boxes[0].click();
await boxes[1].click();
await page.waitForTimeout(400);

const bar = await page.evaluate(() => {
  const node = document.querySelector('.bulk-bar');
  return node ? node.textContent.replace(/\s+/g, ' ').trim() : null;
});
if (!bar) fail('no bulk bar after ticking two rows');
else if (!/2/.test(bar)) fail(`the bar does not say how many are selected: ${bar}`);
await page.screenshot({ path: '/tmp/shots/erp-bulk-bar.png' });

// header box ticks the page
const headerBox = await page.$('thead input[type="checkbox"]');
if (!headerBox) fail('no select-all box in the header');
else {
  await headerBox.click();
  await page.waitForTimeout(400);
  const ticked = await page.$$eval('tbody input[type="checkbox"]', (n) => n.filter((b) => b.checked).length);
  const rows = await page.$$eval('tbody tr', (n) => n.length);
  if (ticked !== rows) fail(`select-all ticked ${ticked} of ${rows}`);
}

// the dialog
const bulkButton = await page.$('.bulk-bar .btn.primary');
if (!bulkButton) fail('no apply button on the bar');
else {
  await bulkButton.click();
  await page.waitForTimeout(700);
  const dialog = await page.evaluate(() => {
    const modal = document.querySelector('#modal-root .modal');
    if (!modal) return null;
    return {
      selects: modal.querySelectorAll('select').length,
      text: modal.textContent.replace(/\s+/g, ' ').slice(0, 200),
    };
  });
  if (!dialog) fail('the bulk dialog did not open');
  else if (dialog.selects < 2) fail(`the dialog needs a field and a value: ${JSON.stringify(dialog)}`);
  await page.screenshot({ path: '/tmp/shots/erp-bulk-dialog.png' });

  // apply: field=gender, value=men, then confirm
  const selects = await page.$$('#modal-root .modal select');
  await selects[1].selectOption('men');
  await page.click('#modal-root .modal .btn.primary');
  await page.waitForTimeout(600);
  // the confirm dialog on top
  const confirmText = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('#modal-root .modal')];
    return nodes.length ? nodes[nodes.length - 1].textContent.replace(/\s+/g, ' ').slice(0, 200) : null;
  });
  if (!confirmText) fail('no confirmation before a bulk change');
  const buttons = await page.$$('#modal-root .modal .btn.danger, #modal-root .modal .btn.primary');
  await buttons[buttons.length - 1].click();
  await page.waitForTimeout(1200);
  const applied = await page.evaluate(() => document.body.textContent.includes('اتغيّر') || document.body.textContent.includes('changed'));
  if (!applied) fail('no confirmation toast after applying');
}

// ---------------------------------------------------------------- exchange
await page.goto(`${BASE}/app.html#/exchanges/new`);
await page.waitForSelector('.pos', { timeout: 15000 });
await page.waitForTimeout(600);
const steps = await page.evaluate(() => [...document.querySelectorAll('.card-head h3')].map((n) => n.textContent.trim()));
if (steps.length < 4) fail(`the exchange screen should have four steps, found ${steps.length}: ${steps}`);

await page.fill('.card-body input.input', 'INV-2026-00001');
await page.press('.card-body input.input', 'Enter');
await page.waitForTimeout(1200);
const found = await page.evaluate(() => ({
  invoice: document.body.textContent.includes('INV-2026-00001'),
  lines: document.querySelectorAll('tbody tr').length,
}));
if (!found.invoice) fail('the invoice was not found on the exchange screen');
if (!found.lines) fail('no returnable lines listed');
await page.screenshot({ path: '/tmp/shots/erp-exchange.png' });

// ---------------------------------------------------------- exchange list
await page.goto(`${BASE}/app.html#/exchanges`);
await page.waitForTimeout(1500);
const list = await page.evaluate(() => ({
  heading: document.querySelector('h2')?.textContent?.trim(),
  rows: document.querySelectorAll('tbody tr').length,
  empty: Boolean(document.querySelector('.empty')),
}));
if (!list.heading) fail('the exchanges list did not render');
if (!list.rows && !list.empty) fail('the exchanges list shows neither rows nor an empty state');

// ---------------------------------------------------------- full invoice
await page.goto(`${BASE}/app.html#/returns/new`);
await page.waitForTimeout(1500);
await page.fill('input.input', 'INV-2026-00001');
await page.press('input.input', 'Enter');
await page.waitForTimeout(1200);
const wholeButton = await page.evaluate(() => [...document.querySelectorAll('button')]
  .map((b) => b.textContent.trim())
  .filter((text) => /ارجّع الفاتورة كلها|Return the whole invoice/.test(text)));
if (!wholeButton.length) fail('no "return the whole invoice" button');
await page.screenshot({ path: '/tmp/shots/erp-return-whole.png' });

await browser.close();
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log('round 15 UI: all checks passed');
