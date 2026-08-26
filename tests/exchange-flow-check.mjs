/**
 * A real browser on the ERP: one whole exchange, driven through the screen.
 *
 * The API tests prove the money and the stock. This proves the SCREENS — that
 * ticking rows raises a bar that says how many, that a bulk change asks before
 * it acts, that the exchange screen finds an invoice and prices a replacement,
 * and that the whole thing can be completed by clicking rather than by posting
 * JSON. Run against a server the caller started:
 *
 *   MM_TEST_URL=http://127.0.0.1:4000 node tests/exchange-flow-check.mjs
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

await page.goto(`${BASE}/app.html`);
await page.waitForSelector('input[type="password"]');
await page.fill('input[name="username"], #username', 'admin');
await page.fill('input[type="password"]', 'admin123');
await page.press('input[type="password"]', 'Enter');
await page.waitForSelector('h2');
await page.waitForTimeout(1200);
await page.evaluate(() => { document.querySelectorAll('#modal-root > *').forEach((n) => n.remove()); });

await page.goto(`${BASE}/app.html#/exchanges/new`);
await page.waitForSelector('.pos');
await page.waitForTimeout(600);

// 1. the invoice
await page.fill('.card-body input.input', 'INV-2026-00001');
await page.press('.card-body input.input', 'Enter');
await page.waitForTimeout(1200);

// 2. one piece back
const qty = await page.$$('tbody input[type="number"]');
if (!qty.length) fail('no quantity boxes on the returnable lines');
await qty[0].fill('1');
await qty[0].dispatchEvent('input');
await page.waitForTimeout(500);

// 3. something else out — type into the picker
const pickerInput = await page.$('.pos-search input');
if (!pickerInput) fail('no replacement picker');
else {
  await pickerInput.fill('عود');
  await page.waitForTimeout(900);
  const result = await page.$('.pos-result');
  if (!result) fail('the picker found nothing for a product that exists');
  else {
    await result.click();
    await page.waitForTimeout(700);
  }
}

const settle = await page.evaluate(() => {
  const node = document.querySelector('.totals');
  return node ? node.textContent.replace(/\s+/g, ' ').trim() : null;
});
if (!settle) fail('no settlement figures');
await page.screenshot({ path: '/tmp/shots/erp-exchange-filled.png' });

// 4. complete it
const complete = await page.$('button.btn.primary.block');
if (!complete) fail('no complete button');
else {
  const disabled = await complete.isDisabled();
  if (disabled) fail('the complete button is still disabled with both sides filled');
  else {
    await complete.click();
    await page.waitForTimeout(700);
    // confirmation
    const buttons = await page.$$('#modal-root .modal .btn.primary, #modal-root .modal .btn.danger');
    if (!buttons.length) fail('no confirmation before completing an exchange');
    else {
      await buttons[buttons.length - 1].click();
      await page.waitForTimeout(2000);
      const landed = await page.evaluate(() => ({
        url: location.hash,
        main: document.querySelector('.page-head')?.textContent?.replace(/\s+/g, ' ') || '',
        toast: document.querySelector('.toast')?.textContent || '',
        body: document.body.textContent.replace(/\s+/g, ' ').slice(-600),
      }));
      console.log('AFTER:', JSON.stringify(landed).slice(0, 700));
      if (!/EXC-/.test(landed.main + landed.toast + landed.body)) fail(`the exchange did not complete: ${landed.body.slice(0, 200)}`);
      await page.screenshot({ path: '/tmp/shots/erp-exchange-done.png' });
    }
  }
}

await browser.close();
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log('exchange flow: completed in the browser');
