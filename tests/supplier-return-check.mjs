/**
 * A whole supplier return, driven through the screen.
 *
 * The API tests prove the money and the shelf. This proves it can be DONE by a
 * person: that the button appears on a received order, that the dialog shows
 * how many are actually on the shelf beside how many arrived, that typing a
 * number and pressing send books it, and that the order afterwards says what is
 * owed - including the case the owner asked about, where the supplier ends up
 * owing the shop.
 *
 *   MM_TEST_URL=http://127.0.0.1:4000 node tests/supplier-return-check.mjs
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

/*
 * A received order to work on, created and received through the API so this
 * check is about the RETURN screen and not about the ten screens before it.
 */
const order = await page.evaluate(async () => {
  const post = async (url, body) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': `c-${Math.random()}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${res.status} ${url} ${await res.text()}`);
    return res.json();
  };
  const stock = await (await fetch('/api/inventory/stock?page=1')).json();
  const variant = stock.rows.find((row) => row.quantity > 0);
  const supplier = await post('/api/suppliers', { name_en: `Check Supplier ${Date.now()}` });
  const created = await post('/api/purchases', {
    supplier_id: supplier.id,
    order_date: new Date().toISOString().slice(0, 10),
    lines: [{ variant_id: variant.variant_id, quantity_ordered: 10, unit_cost: 100, discount_percent: 0, tax_rate: 0 }],
  });
  await post(`/api/purchases/${created.id}/approve`, {});
  const full = await (await fetch(`/api/purchases/${created.id}`)).json();
  await post(`/api/purchases/${created.id}/receive`, {
    receipts: full.lines.map((line) => ({ line_id: line.id, quantity: line.quantity_ordered })),
  });
  // Paid in full, so the interesting half of the feature is what gets tested.
  await post(`/api/purchases/${created.id}/payment`, { amount: 1000, method: 'cash' });
  return { id: created.id, po: created.po_number };
});
console.log(`working on ${order.po}`);

await page.goto(`${BASE}/app.html#/purchases/${order.id}`);
await page.waitForSelector('.page-head', { timeout: 15000 });
await page.waitForTimeout(1500);

const button = await page.evaluate(() => [...document.querySelectorAll('.page-head button')]
  .map((b) => b.textContent.trim())
  .find((text) => /Send back to supplier|مرتجع للمورد/.test(text)) || null);
if (!button) fail('no "send back to supplier" button on a received order');

await page.evaluate(() => {
  const b = [...document.querySelectorAll('.page-head button')]
    .find((n) => /Send back to supplier|مرتجع للمورد/.test(n.textContent || ''));
  if (b) b.click();
});
await page.waitForSelector('#modal-root tbody tr', { timeout: 15000 });
await page.waitForTimeout(600);

const columns = await page.$$eval('#modal-root thead th', (ns) => ns.map((n) => n.textContent.trim()));
console.log('columns:', columns.join(' · '));
for (const wanted of [/Received|استلم/, /On the shelf|على الرف/, /Send back|رجّع/]) {
  if (!columns.some((c) => wanted.test(c))) fail(`the dialog is missing a column matching ${wanted}`);
}

// Send three back.
await page.evaluate(() => {
  const box = document.querySelector('#modal-root tbody input[type="number"]');
  box.value = '3';
  box.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(600);
const totalText = await page.evaluate(() => document.querySelector('#modal-root .muted.small')?.textContent || '');
console.log('dialog total:', totalText);
if (!/300/.test(totalText)) fail(`the dialog總 should show 300 for three at a hundred: ${totalText}`);

await page.evaluate(() => {
  const b = [...document.querySelectorAll('#modal-root button')]
    .find((n) => /^(Send back|رجّع)$/.test((n.textContent || '').trim()));
  if (b) b.click();
});
await page.waitForTimeout(2500);

// The order now says the supplier owes the shop.
await page.goto(`${BASE}/app.html#/purchases/${order.id}`);
await page.waitForTimeout(2000);
const strip = await page.evaluate(() => document.querySelector('.summary-cards')?.innerText.replace(/\n/g, ' | ') || '');
console.log('balance strip:', strip);
if (!/300/.test(strip)) fail(`the order does not show the 300 that went back: ${strip}`);
if (!/owes|ليه عندنا/i.test(strip)) fail(`a fully paid order that was returned must say the supplier owes us: ${strip}`);

// And the return is on the list.
await page.goto(`${BASE}/app.html#/supplier-returns`);
await page.waitForSelector('tbody tr', { timeout: 15000 });
const rows = await page.$$eval('tbody tr', (ns) => ns.length);
console.log(`supplier returns list: ${rows} row(s)`);
if (!rows) fail('the return does not appear on the supplier returns list');

await browser.close();
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log('supplier return: completed in the browser');
