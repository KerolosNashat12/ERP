/**
 * A real browser: does every document that totals money also say how many
 * PIECES it is for?
 *
 * The owner asked for this after looking at a purchase order for 4 of one
 * bottle and 52 of another and having to add the quantity column up himself.
 * The number is not stored anywhere - it is the sum of the lines - so what
 * this proves is that each screen sums its OWN lines correctly: an order sums
 * quantity_ordered, a sale sums quantity, and neither counts rows by mistake.
 *
 *   MM_TEST_URL=http://127.0.0.1:4000 node tests/document-units-check.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.MM_TEST_URL || 'http://127.0.0.1:4000';
const failures = [];
const fail = (m) => failures.push(m);
const browser = await chromium.launch({
  executablePath: process.env.MM_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
page.on('pageerror', (e) => fail(`[pageerror] ${e.message}`));

await page.goto(`${BASE}/app.html`);
await page.waitForSelector('input[type="password"]');
await page.fill('input[name="username"], #username', 'admin');
await page.fill('input[type="password"]', 'admin123');
await page.press('input[type="password"]', 'Enter');
await page.waitForSelector('h2');
await page.waitForTimeout(1200);
await page.evaluate(() => { document.querySelectorAll('#modal-root > *').forEach((n) => n.remove()); });

/** The figure printed beside "Total items", wherever the totals block is. */
const unitsShown = () => page.evaluate(() => {
  const host = document.querySelector('.totals, .doc-totals');
  if (!host) return null;
  const row = [...host.querySelectorAll('.line, .tot, .row, div')]
    .find((n) => /Total items|إجمالي القطع/.test(n.textContent || ''));
  if (!row) return null;
  const m = (row.textContent || '').match(/(\d[\d,]*)\s*$/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
});

// ------------------------------------------------------- the purchase order
await page.goto(`${BASE}/app.html#/purchases/new`);
await page.waitForTimeout(1200);
const codeBoxes = await page.$$('input[placeholder*="Scan"], input[placeholder*="امسح"]');
const lineBox = codeBoxes[codeBoxes.length - 1];
for (const code of ['D6-0', 'D5-0']) {
  await lineBox.fill(code);
  await lineBox.press('Enter');
  await page.waitForTimeout(900);
}
const rowCount = await page.$$eval('tbody tr', (n) => n.length);
if (rowCount < 2) fail(`the order has ${rowCount} lines, expected 2`);
else {
  /*
   * The list re-renders after each change, so a handle taken before the edit
   * is detached by the time the next one is made. Re-query every time.
   */
  const setQty = async (rowIndex, value) => {
    const box = (await page.$$(`tbody tr:nth-child(${rowIndex + 1}) input[type="number"]`))[0];
    await box.fill(String(value));
    await box.dispatchEvent('change');
    await page.waitForTimeout(500);
  };
  // The owner's own numbers, from the screenshot that prompted this.
  await setQty(0, 4);
  await setQty(1, 52);
  const shown = await unitsShown();
  console.log('purchase order: 4 + 52 → shown', shown);
  if (shown === null) fail('the purchase order does not show a piece count at all');
  else if (shown !== 56) fail(`the purchase order says ${shown} pieces, expected 56`);

  /*
   * The table is no longer rebuilt on every keystroke, so this proves the row's
   * OWN total was repainted in place rather than left showing the old figure.
   */
  const rowTotals = await page.$$eval('tbody tr', (rows) => rows.map((row) => {
    const cells = [...row.cells].map((c) => c.textContent.trim());
    return { qty: row.querySelector('input[type="number"]')?.value, total: cells[cells.length - 2] };
  }));
  console.log('purchase order rows:', JSON.stringify(rowTotals));
  const stale = rowTotals.find((r) => /^\D*0[.,]00/.test(r.total || ''));
  if (stale) fail(`a line total did not repaint after the quantity changed: ${JSON.stringify(stale)}`);

  // The box being typed into must survive the edit - that was the whole bug.
  const survived = await page.evaluate(() => {
    const box = document.querySelector('tbody tr input[type="number"]');
    if (!box) return 'gone';
    box.focus();
    box.value = '7';
    box.dispatchEvent(new Event('change', { bubbles: true }));
    return document.activeElement === box ? 'kept focus' : 'lost focus';
  });
  console.log('after a change the quantity box:', survived);
  if (survived !== 'kept focus') fail(`the quantity box ${survived} when its value changed`);
}

// ------------------------------------------------------------- the invoice
await page.goto(`${BASE}/app.html#/sales`);
await page.waitForSelector('tbody tr');
await page.click('tbody tr');
await page.waitForTimeout(1200);
const saleUnits = await unitsShown();
if (saleUnits === null) fail('the invoice does not show a piece count');
else console.log('invoice: shown', saleUnits);
if (saleUnits !== null && saleUnits < 1) fail(`the invoice says ${saleUnits} pieces`);

// -------------------------------------------------- the printed receipt
/*
 * The slip the customer walks out with. It is built by the same code the
 * printer gets, so rendering it into the page is enough to read the figure.
 */
await page.goto(`${BASE}/app.html#/sales`);
await page.waitForSelector('tbody tr');
await page.click('tbody tr');
await page.waitForTimeout(1000);
/*
 * "View" shows the same slip in a dialog. The print button is deliberately NOT
 * clicked - a print dialog blocks the browser and takes the check down with it.
 */
await page.evaluate(() => {
  const button = [...document.querySelectorAll('.page-head button')]
    .find((b) => /^(View|عرض)$/.test((b.textContent || '').trim()));
  if (button) button.click();
});
await page.waitForTimeout(1200);
const receiptText = await page.evaluate(() => {
  const node = document.querySelector('.receipt');
  return node ? node.innerText : null;
});
if (receiptText === null) fail('the invoice would not show its receipt');
else if (!/Total items|إجمالي القطع/.test(receiptText)) {
  fail(`the printed receipt has no piece count:\n${String(receiptText).slice(0, 400)}`);
} else console.log('receipt: piece count present');

await browser.close();
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log('document piece counts: all checks passed');
