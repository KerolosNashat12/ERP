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
  /*
   * Something to send back. A shop that has been trading already has plenty;
   * an empty one - a fresh database, which is what this runs against in CI -
   * has none, and a check that only works on a populated shop is a check
   * nobody can run before they have a problem.
   */
  const stock = await (await fetch('/api/inventory/stock?page=1')).json();
  let variantId = (stock.rows || []).find((row) => row.quantity > 0)?.variant_id || null;
  const supplier = await post('/api/suppliers', { name_en: `Check Supplier ${Date.now()}` });
  if (!variantId) {
    const stamp = Date.now().toString(36).toUpperCase().slice(-5);
    const product = await post('/api/products', {
      sku_prefix: `CHK${stamp}`,
      name_en: `Check product ${stamp}`,
      name_ar: `منتج اختبار ${stamp}`,
      base_price: 300,
      variants: [{ sku: `CHK${stamp}-1`, variant_label: '', cost_price: 100, selling_price: 300 }],
    });
    variantId = product.variants[0].id;
  }
  const created = await post('/api/purchases', {
    supplier_id: supplier.id,
    order_date: new Date().toISOString().slice(0, 10),
    lines: [{ variant_id: variantId, quantity_ordered: 10, unit_cost: 100, discount_percent: 0, tax_rate: 0 }],
  });
  await post(`/api/purchases/${created.id}/approve`, {});
  const full = await (await fetch(`/api/purchases/${created.id}`)).json();
  await post(`/api/purchases/${created.id}/receive`, {
    receipts: full.lines.map((line) => ({ line_id: line.id, quantity: line.quantity_ordered })),
  });
  // Paid in full, so the interesting half of the feature is what gets tested.
  await post(`/api/purchases/${created.id}/payment`, { amount: 1000, method: 'cash' });

  /*
   * Something DIFFERENT for the supplier to send instead — the owner's case.
   * Made here, and its code handed back, so the picker below searches for a
   * product this check knows exists rather than for one that happened to be in
   * somebody's shop the day the check was written.
   */
  const stamp = Date.now().toString(36).toUpperCase().slice(-5);
  const swapProduct = await post('/api/products', {
    sku_prefix: `SWP${stamp}`,
    name_en: `Swap target ${stamp}`,
    name_ar: `بديل ${stamp}`,
    base_price: 400,
    variants: [{ sku: `SWP${stamp}-1`, variant_label: '', cost_price: 150, selling_price: 400 }],
  });
  return { id: created.id, po: created.po_number, swapSku: swapProduct.variants[0].sku };
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

/*
 * And the case the owner asked for by name: not sending it back for a credit,
 * but swapping it for a DIFFERENT item. The dialog has to let one be chosen,
 * price it at its own cost, and move both items on the shelf.
 */
await page.goto(`${BASE}/app.html#/purchases/${order.id}`);
await page.waitForTimeout(1800);
/*
 * The swap is its OWN button now, not a setting inside the return dialog. The
 * owner's words: «ضفنا تبديل اصلا لوحدها ف المفروض تتشال من المرتجع». So the
 * check is in two halves - the return screen must NOT offer to become
 * something else, and the swap screen must arrive with its columns already
 * there.
 */
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.page-head button')]
    .find((n) => /Send back to supplier|مرتجع للمورد/.test(n.textContent || ''));
  if (b) b.click();
});
await page.waitForSelector('#modal-root tbody tr', { timeout: 15000 });
/*
 * Read the dialog by its TITLE rather than by "whatever is in #modal-root".
 *
 * A fresh shop opens with "Change password" already on screen — every account
 * still on a seeded default is made to change it — and that dialog sits in the
 * same #modal-root. A selector that means "the first table in the modal root"
 * therefore reads whichever dialog happens to be first in the DOM, which is how
 * this check spent three runs reporting that a swap dialog had no swap columns
 * while looking at a completely different dialog.
 */
const dialogNamed = (pattern) => page.evaluateHandle((source) => {
  const rule = new RegExp(source);
  return [...document.querySelectorAll('#modal-root > *')]
    .find((node) => rule.test(node.querySelector('.modal-head h3')?.textContent || '')) || null;
}, pattern);

const readDialog = async (pattern) => {
  const handle = await dialogNamed(pattern);
  return handle.evaluate((node) => (node ? {
    columns: [...node.querySelectorAll('thead th')].map((n) => n.textContent.trim()),
    hasSelect: Boolean(node.querySelector('select')),
    firstRow: node.querySelector('tbody tr')?.innerText.replace(/\n/g, ' | ') || '',
  } : null));
};

const returnDialog = await readDialog('Send back to supplier|مرتجع للمورد');
if (!returnDialog) fail('the return dialog did not open');
else {
  if (returnDialog.hasSelect) fail('the plain return dialog still carries a settlement picker');
  if (returnDialog.columns.some((c) => /instead|بدله/.test(c))) {
    fail('the plain return dialog is still showing the replacement columns');
  }
}
// Close it by the button inside THAT dialog, for the same reason.
await page.evaluate(() => {
  const node = [...document.querySelectorAll('#modal-root > *')]
    .find((n) => /Send back to supplier|مرتجع للمورد/.test(n.querySelector('.modal-head h3')?.textContent || ''));
  node?.querySelector('.modal-head button')?.click();
});
await page.waitForTimeout(600);

// Now the swap door, which must open with the columns already in place.
const swapOpened = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.page-head button')]
    .find((n) => /Swap with the supplier|استبدال من المورد/.test(n.textContent || ''));
  if (!b) return false;
  b.click();
  return true;
});
if (!swapOpened) fail('there is no swap button on the purchase order');
await page.waitForSelector('#modal-root tbody tr', { timeout: 15000 });
await page.waitForTimeout(400);
const swapDialog = await readDialog('Swap with the supplier|استبدال من المورد');
if (!swapDialog) fail('the swap dialog did not open');
else {
  if (!swapDialog.columns.some((c) => /Coming back|الراجع/.test(c))) fail('the swap dialog has no coming-back column');
  if (!swapDialog.columns.some((c) => /instead|بدله/.test(c))) fail('no column for choosing a different item');
  if (swapDialog.hasSelect) fail('the swap dialog is still asking which kind of document this is');
}

const opened = await page.evaluate(() => {
  const b = [...document.querySelectorAll('#modal-root tbody button')]
    .find((n) => /A different item|صنف تاني/.test(n.textContent || ''));
  if (!b) return false;
  b.click();
  return true;
});
if (!opened) fail('no "a different item" button on the replacement row');
else {
  await page.waitForTimeout(900);
  /*
   * The picker's own search box, addressed by the thing it belongs to rather
   * than by "the last input in the dialog" — which quietly became the cost box
   * the day numberInput started carrying an empty placeholder attribute, so
   * this typed a SKU into a price field and then reported that the picker
   * found nothing.
   */
  const search = await page.$('#modal-root .pos-search input');
  if (!search) fail('the replacement picker has no search box');
  else await search.fill(order.swapSku);
  await page.waitForTimeout(1400);
  const picked = await page.evaluate(() => {
    const hit = document.querySelector('#modal-root .pos-result');
    if (!hit) return false;
    hit.click();
    return true;
  });
  if (!picked) fail('the item picker found nothing to choose');
  else {
    await page.waitForTimeout(500);
    const saved = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('#modal-root button')];
      const save = buttons.reverse().find((n) => /^(Save|حفظ)$/.test((n.textContent || '').trim()));
      if (!save) return false;
      save.click();
      return true;
    });
    if (!saved) fail('could not confirm the chosen item');
    await page.waitForTimeout(900);
    const row = (await readDialog('Swap with the supplier|استبدال من المورد'))?.firstRow || '';
    console.log('replacement row:', row);
    if (!row.includes(order.swapSku)) fail(`the chosen item is not shown on the row: ${row}`);
  }
}
/*
 * And now the half the owner asked about out loud: «لو في فلوس ليا عند المورد
 * او هو ليه فرق فلوس؟» — so the swap is actually SENT, and the strip is read.
 *
 * Two of the four bottles that went back are replaced by two at 150 against
 * bottles that cost 100, so the shop has received 100 MORE than it sent and
 * owes 100 more. The version this replaced credited the shop for the 200 that
 * went out and ignored the 300 that came in, on a screen that looked entirely
 * normal.
 */
// What the order said before the swap, so the swap is measured as a CHANGE —
// this order already carries the 3-bottle return from the first half of this
// file, and an absolute figure here would be asserting both at once.
const beforeSwap = await page.evaluate(async (id) => (await (await fetch(`/api/purchases/${id}/balance`)).json()), order.id);

await page.evaluate(() => {
  const node = [...document.querySelectorAll('#modal-root > *')]
    .find((n) => /Swap with the supplier|استبدال من المورد/.test(n.querySelector('.modal-head h3')?.textContent || ''));
  const boxes = [...(node?.querySelectorAll('tbody tr input[type="number"]') || [])];
  // First box is what goes back, second is what comes in against it.
  if (boxes[0]) { boxes[0].value = '2'; boxes[0].dispatchEvent(new Event('change', { bubbles: true })); }
});
await page.waitForTimeout(700);
const sent = await page.evaluate(() => {
  const node = [...document.querySelectorAll('#modal-root > *')]
    .find((n) => /Swap with the supplier|استبدال من المورد/.test(n.querySelector('.modal-head h3')?.textContent || ''));
  const boxes = [...(node?.querySelectorAll('tbody tr input[type="number"]') || [])];
  if (boxes[1]) { boxes[1].value = '2'; boxes[1].dispatchEvent(new Event('change', { bubbles: true })); }
  const go = [...(node?.querySelectorAll('.modal-foot button') || [])][0];
  if (!go) return false;
  go.click();
  return true;
});
if (!sent) fail('the swap dialog has no button to send it');
await page.waitForTimeout(3000);

await page.goto(`${BASE}/app.html#/purchases/${order.id}`);
await page.waitForTimeout(2200);
const swapStrip = await page.evaluate(() => document.querySelector('.summary-cards')?.innerText.replace(/\n/g, ' | ') || '');
console.log('strip after the swap:', swapStrip);
if (!/Came back instead|جه بدله/i.test(swapStrip)) {
  fail(`the strip does not say what came back in exchange: ${swapStrip}`);
}
if (!/300/.test(swapStrip)) fail(`the 300 that came in is not on the strip: ${swapStrip}`);

// And the number itself, asked of the server rather than read off a card.
const money = await page.evaluate(async (id) => (await (await fetch(`/api/purchases/${id}/balance`)).json()), order.id);
console.log('balance after the swap:', JSON.stringify(money));
const moved = (key) => Math.round((money[key] - beforeSwap[key]) * 100) / 100;
if (moved('returned_amount') !== 200) fail(`the swap sent back ${moved('returned_amount')}, expected 200`);
if (moved('replacement_amount') !== 300) fail(`${moved('replacement_amount')} came back instead, expected 300`);
if (moved('credit_amount') !== -100) {
  fail(`the swap moved the credit by ${moved('credit_amount')}; 200 went out and 300 came in, so it is worth −100`);
}
if (moved('net_amount') !== 100) {
  fail(`the order moved by ${moved('net_amount')}; the shop received 100 more than it sent, so it owes 100 more`);
}

// And the return is on the list.
await page.goto(`${BASE}/app.html#/supplier-returns`);
await page.waitForSelector('tbody tr', { timeout: 15000 });
const rows = await page.$$eval('tbody tr', (ns) => ns.length);
console.log(`supplier returns list: ${rows} row(s)`);
if (!rows) fail('the return does not appear on the supplier returns list');

await browser.close();
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log('supplier return: completed in the browser');
