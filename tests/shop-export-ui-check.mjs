/**
 * Settings → النسخ الاحتياطية, on the deployment that was photographed.
 *
 * One shop, on the HOSTED driver — the case where pressing «إنشاء نسخة
 * احتياطية» used to answer with an English sentence saying the owner could not
 * have a copy of his own data. This stands that shop up, signs in as its own
 * administrator (not the platform owner), presses the button in both languages,
 * takes what comes out and OPENS it.
 *
 * Development aid, not part of the shipped app or of `npm test`.
 *   node tests/shop-export-ui-check.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT = process.env.MM_SHOT_DIR || '/tmp/mm-shop-export-shots';
const DATA = process.env.MM_UI_DATA || '/tmp/mm-shop-export-data';
fs.rmSync(OUT, { recursive: true, force: true });
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.join(DATA, 'tenants'), { recursive: true });

process.env.MM_PLATFORM = '1';
process.env.MM_PLATFORM_DB = path.join(DATA, 'platform.db');
process.env.MM_TENANTS_DIR = path.join(DATA, 'tenants');
process.env.MM_DB_FILE = path.join(DATA, 'default.db');
process.env.MM_DATA_DIR = DATA;
process.env.MM_PLATFORM_OWNER_PASSWORD = 'walkthrough-owner-password';
process.env.MM_DEFAULT_TENANT = '';
process.env.MM_JWT_SECRET = 'walkthrough-secret';

const { createApp } = await import('../src/server.js');
const conn = await import('../src/infrastructure/database/connection.js');
const { initPlatformDb, platformDb } = await import('../src/platform/db.js');
const tenantService = (await import('../src/platform/TenantService.js')).default;
const { MODULES } = await import('../src/shared/permissions.js');

await conn.initDb();
await initPlatformDb();

const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`  FAIL ${msg}`); };
const ok = (msg) => console.log(`  ok   ${msg}`);

/* ───────────────────────────────────────────────── one shop, hosted driver */

const SLUG = 'mm';
const dbFile = path.join(DATA, 'tenants', `${SLUG}.db`);
const created = await tenantService.create({
  slug: SLUG,
  nameEn: 'M&M Accessories',
  nameAr: 'إم آند إم للإكسسوارات',
  modules: Object.keys(MODULES),
  // `file:` is the same driver a Turso URL uses — this is the hosted case.
  database: { mode: 'libsql', url: `file:${dbFile}` },
});

const row = await platformDb().prepare('SELECT * FROM tenants WHERE slug = ?').get(SLUG);
const c = await conn.openConnection({ driver: row.driver, url: row.db_url, file: row.db_file });
await conn.runWithTenant({ slug: SLUG }, c, async () => {
  const db = c.facade;
  await db.prepare("INSERT INTO suppliers (id, code, name_en, name_ar, phone, city) VALUES (1,'S-1','Cairo Gold Supply','الشركة الذهبية للتوريد','0221234567','Cairo')").run();
  await db.prepare("INSERT INTO brands (id, code, name_en, name_ar) VALUES (1,'AURA','Aura','أورا')").run();
  await db.prepare("INSERT INTO categories (id, code, name_en, name_ar) VALUES (1,'RING','Rings','خواتم')").run();
  for (let i = 1; i <= 60; i += 1) {
    await db.prepare(`INSERT INTO products (id, sku_prefix, name_en, name_ar, brand_id, category_id, supplier_id, unit, base_cost, base_price)
      VALUES (?,?,?,?,1,1,1,'pc',?,?)`)
      .run(i, `SKU${i}`, `Silver ring ${i}`, `خاتم فضة رقم ${i}`, 60 + i, 150 + i * 2);
    await db.prepare(`INSERT INTO product_variants (id, product_id, sku, barcode, variant_label, cost_price, selling_price)
      VALUES (?,?,?,?,?,?,?)`)
      .run(i, i, `SKU${i}-01`, `62210000${String(i).padStart(5, '0')}`, 'Medium', 60 + i, 150 + i * 2);
    await db.prepare('INSERT INTO stock_levels (variant_id, warehouse_id, quantity, average_cost) VALUES (?,1,?,?)')
      .run(i, 20 + (i % 30), 60 + i);
  }
  for (let i = 1; i <= 240; i += 1) {
    await db.prepare('INSERT INTO customers (id, code, name, phone, city, balance, loyalty_points) VALUES (?,?,?,?,?,?,?)')
      .run(i, `C-${i}`, `عميل رقم ${i}`, `0100${String(1000000 + i)}`, 'Giza', (i % 40) * 2.5, i % 300);
  }
  for (let i = 1; i <= 300; i += 1) {
    await db.prepare(`INSERT INTO sales (id, invoice_no, customer_id, warehouse_id, status, sale_date, subtotal, tax_amount, total_amount, total_cost, paid_amount, payment_method, created_by)
      VALUES (?,?,?,1,'completed',?,?,?,?,?,?,?,1)`)
      .run(i, `INV-2026-${String(i).padStart(5, '0')}`, 1 + (i % 240),
        `2026-0${1 + (i % 8)}-${String(1 + (i % 28)).padStart(2, '0')}`,
        180 + (i % 400), 25, 205 + (i % 400), 90 + (i % 200), 205 + (i % 400),
        i % 3 === 0 ? 'card' : 'cash');
    await db.prepare(`INSERT INTO sale_lines (id, sale_id, variant_id, sku, description, quantity, unit_price, unit_cost, tax_rate, tax_amount, line_total)
      VALUES (?,?,?,?,?,?,?,?,14,?,?)`)
      .run(i, i, 1 + (i % 60), `SKU${1 + (i % 60)}-01`, `خاتم فضة رقم ${1 + (i % 60)}`,
        1 + (i % 3), 150 + (i % 120), 60 + (i % 60), 25, 205 + (i % 400));
  }
  await db.prepare("INSERT INTO employees (code, name, job_title, phone, salary_amount, salary_period, warehouse_id) VALUES ('E-1','مروة عبد الله','Cashier','01099887766',6500,'month',1)").run();
  await db.prepare("INSERT INTO employees (code, name, job_title, phone, salary_amount, salary_period, warehouse_id) VALUES ('E-2','أحمد سيد','Delivery','01055443322',4200,'month',1)").run();
});
await c.close();
console.log(`  seeded ${SLUG} on ${row.driver}`);

const app = createApp();
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const BASE = `http://127.0.0.1:${server.address().port}`;
console.log(`  server on ${BASE}`);

/* ─────────────────────────────────────────────────────────────── the browser */

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const context = await browser.newContext({
  viewport: { width: 1500, height: 1000 },
  acceptDownloads: true,
});
const page = await context.newPage();

const errors = [];
const EXPECTED = [/\b401\b/, /\b429\b/, /The server did not answer/];
page.on('console', (msg) => {
  if (msg.type() !== 'error') return;
  const text = msg.text();
  if (EXPECTED.some((p) => p.test(text))) return;
  errors.push(`[console] ${text} @ ${page.url()}`);
});
page.on('pageerror', (error) => errors.push(`[pageerror] ${error.message}`));

const shot = async (name) => {
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  console.log('  shot', name);
};

const NEW_PASSWORD = 'shopOwner!2026';

async function signIn(lang) {
  await page.goto(`${BASE}/t/${SLUG}/`);
  await page.evaluate((value) => localStorage.setItem('mm.lang', value), lang);
  await page.reload();
  await page.waitForSelector('.shell, .login-card', { timeout: 20000 });

  if (await page.locator('.login-card').isVisible().catch(() => false)) {
    for (const password of [created.adminPassword, NEW_PASSWORD]) {
      await page.fill('input[name=username]', created.adminUsername);
      await page.fill('input[name=password]', password);
      await page.click('button[type=submit]');
      try {
        await page.waitForSelector('.shell', { timeout: 8000 });
        break;
      } catch { await page.waitForTimeout(400); }
    }
  }
  await page.waitForSelector('.shell', { timeout: 20000 });
  await page.waitForTimeout(1200);

  // First sign-in asks for a new password; the walkthrough is not about that.
  if (await page.locator('.modal input[name=currentPassword]').count()) {
    await page.fill('.modal input[name=currentPassword]', created.adminPassword);
    await page.fill('.modal input[name=newPassword]', NEW_PASSWORD);
    await page.fill('.modal input[name=confirmPassword]', NEW_PASSWORD);
    await page.locator('.modal-foot button.primary, .modal button.primary').last().click();
    await page.waitForTimeout(2000);
  }
  if (await page.locator('.modal-backdrop').count()) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
  }
}

/**
 * The language the STAFF MEMBER reads, not the one this script left in
 * localStorage: after a sign-in the user's own `language` column wins (see
 * app.js), so the only honest way to switch is the switch in the top bar —
 * which is also what a shop owner presses.
 */
async function useLanguage(lang) {
  const current = await page.evaluate(() => document.documentElement.lang);
  if (current === lang) return;
  await page.locator('.topbar button', { hasText: /^(ع|EN)$/ }).first().click();
  await page.waitForTimeout(2500);
  await page.waitForSelector('.shell', { timeout: 20000 });
  const now = await page.evaluate(() => document.documentElement.lang);
  if (now !== lang) fail(`could not switch the ERP to ${lang} (it is ${now})`);
  else ok(`the ERP is in ${lang}, and reads ${await page.evaluate(() => document.documentElement.dir)}`);
}

async function openBackupsTab() {
  await page.goto(`${BASE}/t/${SLUG}/#/settings`);
  await page.waitForSelector('.shell', { timeout: 20000 });
  await page.waitForTimeout(1200);
  const tab = page.locator('.tabs button, .tab, button').filter({
    hasText: /^(Backups|النسخ الاحتياطية)$/,
  }).first();
  await tab.click();
  await page.waitForTimeout(1500);
}

/* ───────────────────────────────────────────────────── Arabic: the photograph */

await signIn('ar');
await useLanguage('ar');
await openBackupsTab();
await shot('01-backups-ar');

const arabicText = await page.locator('.view, #view, main').first().innerText();
if (/deployment|libsql|provider/i.test(arabicText)) {
  fail('English words about the driver are still on the Arabic screen');
} else {
  ok('no English driver sentence on the Arabic screen');
}
if (!/نسخة من بياناتك|نزّل نسخة/.test(arabicText)) {
  fail('the Arabic screen does not offer the shop its own data');
} else {
  ok('the Arabic screen offers «نزّل نسخة من بياناتي»');
}

/* ───────────────────────────────────────────────────── press it, in Arabic */

const downloadButton = () => page.locator('button').filter({
  hasText: /نزّل نسخة من بياناتي|Download a copy of my data/,
}).first();

const download = await Promise.all([
  page.waitForEvent('download', { timeout: 120000 }),
  downloadButton().click(),
]).then(([event]) => event).catch((error) => {
  fail(`no download started: ${error.message}`);
  return null;
});

await page.waitForTimeout(1500);
await shot('02-downloaded-ar');

let file = null;
if (download) {
  file = path.join(OUT, download.suggestedFilename());
  await download.saveAs(file);
  const { size } = fs.statSync(file);
  ok(`downloaded ${download.suggestedFilename()} (${(size / 1024).toFixed(0)} KB)`);
}

/* ────────────────────────────────────────── open what came out, and read it */

/** A ZIP reader in twenty lines — enough to check what came out of the download. */
function readZip(buffer) {
  const entries = new Map();
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054B50) end -= 1;
  const count = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < count; i += 1) {
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const offset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const method = buffer.readUInt16LE(offset + 8);
    const compressed = buffer.readUInt32LE(offset + 18);
    const localName = buffer.readUInt16LE(offset + 26);
    const localExtra = buffer.readUInt16LE(offset + 28);
    const start = offset + 30 + localName + localExtra;
    const bytes = buffer.subarray(start, start + compressed);
    entries.set(name, method === 8 ? zlib.inflateRawSync(bytes) : bytes);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const decodeXml = (text) => text
  .replaceAll('&quot;', '"').replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');

if (file) {
  const entries = readZip(fs.readFileSync(file));
  const names = [...entries.keys()];
  console.log(`  archive holds ${names.length} entries`);

  if (!entries.has('README.txt')) fail('no README.txt');
  else {
    const readme = entries.get('README.txt').toString('utf8');
    ok(`README.txt reads in both languages (${/العربية/.test(readme) ? 'Arabic present' : 'ARABIC MISSING'})`);
    console.log(readme.split('\n').slice(0, 5).map((line) => `      ${line}`).join('\n'));
  }

  const books = names.filter((n) => n.endsWith('.xlsx'));
  if (books.length !== 2) fail(`expected two workbooks, found ${books.length}`);
  for (const book of books) {
    const inner = readZip(entries.get(book));
    const workbook = inner.get('xl/workbook.xml').toString('utf8');
    const sheets = [...workbook.matchAll(/<sheet name="([^"]+)"/g)].map((m) => decodeXml(m[1]));
    const sheet1 = inner.get('xl/worksheets/sheet1.xml').toString('utf8');
    const cells = [...sheet1.matchAll(/<t xml:space="preserve">([^<]*)<\/t>/g)]
      .map((m) => decodeXml(m[1])).slice(0, 8);
    console.log(`      ${book}: ${sheets.length} tabs — ${sheets.slice(0, 6).join(' · ')}`);
    console.log(`        first cells: ${cells.join(' | ')}`);
    if (/rightToLeft="1"/.test(sheet1) !== book.endsWith('-ar.xlsx')) {
      fail(`${book} has the wrong reading direction`);
    }
  }

  const manifest = JSON.parse(entries.get('snapshot/manifest.json').toString('utf8'));
  ok(`manifest: ${manifest.totals.rows} rows across ${manifest.tables.length} tables, `
    + `redacted ${JSON.stringify(manifest.redacted)}`);
  const users = entries.get('snapshot/users.0001.jsonl').toString('utf8');
  if (/\$2[aby]\$/.test(users)) fail('a password hash travelled in the shop\'s own copy');
  else ok('no password hash in the shop\'s own copy');
  const customers = names.filter((n) => n.startsWith('snapshot/customers.'));
  if (!customers.length) fail('no clients in the snapshot');
  else ok(`the clients are there (${customers.length} part(s))`);
}

/* ───────────────────────────────────── press it again: the rate limit, in Arabic */

await downloadButton().click();
await page.waitForTimeout(2500);
const toastText = await page.locator('.toast').last().innerText().catch(() => '');
console.log(`  second press says: ${toastText}`);
if (/[A-Za-z]{6,}/.test(toastText)) fail(`the refusal is in English: ${toastText}`);
else ok('the refusal is in Arabic');
await shot('03-rate-limited-ar');

/* ────────────────────────────────────────────────────────────────── English */

await useLanguage('en');
await openBackupsTab();
await shot('04-backups-en');
const englishText = await page.locator('.view, #view, main').first().innerText();
if (!/Download a copy of my data/.test(englishText)) fail('the English screen does not offer the download');
else ok('the English screen offers "Download a copy of my data"');

// The permission checkboxes, which used to read `reverse_payment` in Arabic.
await page.goto(`${BASE}/t/${SLUG}/#/users`);
await page.waitForTimeout(1800);
await page.locator('button').filter({ hasText: /^(Edit|تعديل)$/ }).first().click().catch(() => {});
await page.waitForTimeout(1200);
await shot('05-role-permissions-en');
await page.keyboard.press('Escape').catch(() => {});

await useLanguage('ar');
await page.goto(`${BASE}/t/${SLUG}/#/users`);
await page.waitForTimeout(2000);
await page.locator('button').filter({ hasText: /^(Edit|تعديل)$/ }).first().click().catch(() => {});
await page.waitForTimeout(1200);
await shot('06-role-permissions-ar');

/* ─────────────────────────────────────────────────────────────────── verdict */

await browser.close();
await new Promise((resolve) => server.close(resolve));

for (const error of errors) console.log(`  JS   ${error}`);
console.log(errors.length ? `  ${errors.length} console error(s)` : '  no console errors');
console.log(failures.length ? `\n✖ ${failures.length} failure(s)` : '\n✔ all checks passed');
console.log(`  screenshots in ${OUT}`);
process.exit(failures.length ? 1 : 0);
