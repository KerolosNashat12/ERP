/**
 * The products screen's new "Export CSV" button, driven the way a person
 * actually uses it: sign in, open Products, click the button, and check what
 * actually lands in the browser's downloads — not just that the endpoint
 * answers 200 when asked directly.
 *
 * Development aid, not part of the shipped app or of `npm test`.
 *   MM_TEST_URL=http://127.0.0.1:4321 node tests/products-export-check.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.MM_TEST_URL || 'http://127.0.0.1:4321';
const errors = [];
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, acceptDownloads: true });
page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));
// The pre-login /auth/me probe answers 401 by design; nothing else is expected.
const EXPECTED = [/\b401\b/];
page.on('console', (msg) => {
  if (msg.type() !== 'error') return;
  const text = msg.text();
  if (EXPECTED.some((p) => p.test(text))) return;
  errors.push(`[console] ${text}`);
});

async function report(ok, label) {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}`);
  if (!ok) process.exitCode = 1;
}

await page.goto(`${BASE}/`);
await page.waitForTimeout(800);
await page.fill('input[name=username]', 'admin');
await page.fill('input[name=password]', 'admin123');
await page.click('form button[type=submit]');
await page.waitForTimeout(2200);

// A fresh admin is forced to change its password — dismiss that dialog if it
// is there, the same trap documented for every other browser check here.
const changePwDialog = page.locator('#modal-root .modal:has-text("Change password"), #modal-root .modal:has-text("تغيير كلمة")');
if (await changePwDialog.count()) {
  await changePwDialog.locator('button:has-text("✕")').first().click().catch(() => {});
  await page.waitForTimeout(300);
}

await page.goto(`${BASE}/#/products`);
await page.waitForSelector('table, .card', { timeout: 15000 });
await page.waitForTimeout(800);

const exportButton = page.locator('button:has-text("Export CSV"), button:has-text("تصدير CSV")').first();
await report(await exportButton.count() > 0, 'the Export CSV button is on the products screen');

const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 10000 }),
  exportButton.click(),
]);
const savedTo = path.join(os.tmpdir(), `mm-products-export-${Date.now()}.csv`);
await download.saveAs(savedTo);
const text = fs.readFileSync(savedTo, 'utf8');
const lines = text.replace(/^﻿/, '').split('\n').filter(Boolean);

await report(download.suggestedFilename() === 'products.csv', `the file is named products.csv (got "${download.suggestedFilename()}")`);
await report(lines.length > 1, `the file has a header row and at least one product row (got ${lines.length} line(s))`);
await report(/SKU/.test(lines[0]) && /Product/.test(lines[0]), `the header names real columns (got "${lines[0]}")`);

await report(errors.length === 0, `no console/page errors (${errors.length} found)`);
if (errors.length) errors.forEach((e) => console.log('   ', e));

await browser.close();
console.log(process.exitCode ? '\nFAILED' : '\nALL PASSED');
