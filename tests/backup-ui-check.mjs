/**
 * The backup feature, used the way the owner will use it.
 *
 * Stands up a fleet of four shops with real data in them, signs into KJ Admin,
 * and then does the whole thing in a browser: sees which shops are behind on
 * their backups from the Shops list WITHOUT opening one, takes a backup, downloads
 * it, OPENS WHAT CAME OUT and checks it is actually readable, and restores it —
 * after changing the shop, so the restore has something to prove.
 *
 * Every screen is captured in Arabic and in English.
 *
 * Development aid, not part of the shipped app or of `npm test`.
 *   node tests/backup-ui-check.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT = process.env.MM_SHOT_DIR || '/tmp/mm-backup-shots';
const DATA = '/tmp/mm-backup-ui-data';
fs.rmSync(OUT, { recursive: true, force: true });
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.join(DATA, 'tenants'), { recursive: true });

process.env.MM_PLATFORM = '1';
process.env.MM_PLATFORM_DB = path.join(DATA, 'platform.db');
process.env.MM_TENANTS_DIR = path.join(DATA, 'tenants');
process.env.MM_DB_FILE = path.join(DATA, 'default.db');
process.env.MM_PLATFORM_OWNER_PASSWORD = 'walkthrough-owner-password';
process.env.MM_DEFAULT_TENANT = '';
process.env.MM_JWT_SECRET = 'walkthrough-secret';

const { createApp } = await import('../src/server.js');
const conn = await import('../src/infrastructure/database/connection.js');
const { initPlatformDb, platformDb, closePlatformDb } = await import('../src/platform/db.js');
const tenantService = (await import('../src/platform/TenantService.js')).default;
const backupService = (await import('../src/platform/BackupService.js')).default;
const { MODULES } = await import('../src/shared/permissions.js');

await conn.initDb();
await initPlatformDb();

const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`  FAIL ${msg}`); };
const ok = (msg) => console.log(`  ok   ${msg}`);

/* ─────────────────────────────────────────────────────────────── the fleet */

const SHOPS = [
  { slug: 'mm', en: 'M&M Accessories', ar: 'إم آند إم للإكسسوارات', customers: 240, sales: 300 },
  { slug: 'zamalek', en: 'Zamalek Boutique', ar: 'بوتيك الزمالك', customers: 90, sales: 120 },
  { slug: 'nasr-city', en: 'Nasr City Store', ar: 'فرع مدينة نصر', customers: 40, sales: 60 },
  { slug: 'tanta', en: 'Tanta Branch', ar: 'فرع طنطا', customers: 12, sales: 8 },
];

async function fill(shop) {
  const row = await platformDb().prepare('SELECT * FROM tenants WHERE slug = ?').get(shop.slug);
  const c = await conn.openConnection({ driver: 'sqlite', file: row.db_file });
  await conn.runWithTenant({ slug: shop.slug }, c, async () => {
    await conn.transaction(async () => {
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
      for (let i = 1; i <= shop.customers; i += 1) {
        await db.prepare('INSERT INTO customers (id, code, name, phone, city, balance, loyalty_points) VALUES (?,?,?,?,?,?,?)')
          .run(i, `C-${i}`, `عميل رقم ${i}`, `0100${String(1000000 + i)}`, 'Giza', (i % 40) * 2.5, i % 300);
      }
      for (let i = 1; i <= shop.sales; i += 1) {
        await db.prepare(`INSERT INTO sales (id, invoice_no, customer_id, warehouse_id, status, sale_date, subtotal, tax_amount, total_amount, total_cost, paid_amount, payment_method, created_by)
          VALUES (?,?,?,1,'completed',?,?,?,?,?,?,?,1)`)
          .run(i, `INV-2026-${String(i).padStart(5, '0')}`, 1 + (i % shop.customers),
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
  });
  await c.close();
}

for (const shop of SHOPS) {
  await tenantService.create({
    slug: shop.slug, nameEn: shop.en, nameAr: shop.ar, modules: Object.keys(MODULES),
  });
  await fill(shop);
  console.log(`  seeded ${shop.slug}`);
}

/**
 * Three of the four have been backed up; one never has. That is the state the
 * Shops list has to make obvious without anyone opening a shop, and one of the
 * three is deliberately aged so the "overdue" case is on screen too.
 */
await backupService.take('mm', { kind: 'scheduled' });
await backupService.take('zamalek', { kind: 'scheduled' });
const stale = await backupService.take('nasr-city', { kind: 'scheduled' });
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
await platformDb().prepare('UPDATE tenant_backups SET taken_at = ?, finished_at = ? WHERE id = ?')
  .run(daysAgo(6), daysAgo(6), stale.id);
// 'tanta' is left with none at all.

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
/**
 * Two failures this walkthrough causes itself and must not blame the app for:
 * the pre-login `/auth/me` probe answers 401 by design, and the Overview screen
 * that the shell opens on has its fetch cancelled the moment this script
 * navigates to Shops. Everything else is a real error.
 */
const EXPECTED = [/\b401\b/, /The server did not answer/];
page.on('console', (msg) => {
  if (msg.type() !== 'error') return;
  const text = msg.text();
  if (EXPECTED.some((p) => p.test(text))) return;
  errors.push(`[console] ${text} @ ${page.url()}`);
});
page.on('pageerror', (error) => errors.push(`[pageerror] ${error.message}`));

const shot = async (name) => {
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  console.log('  shot', name);
};

async function signIn(lang) {
  await page.goto(`${BASE}/platform/`);
  await page.evaluate((value) => localStorage.setItem('mm.platform.lang', value), lang);
  await page.reload();
  await page.waitForSelector('.shell, input[name="username"]', { timeout: 20000 });
  if (await page.locator('input[name="username"]').isVisible().catch(() => false)) {
    await page.locator('input[name="username"]').fill('owner');
    await page.locator('input[name="password"]').fill('walkthrough-owner-password');
    await page.locator('button[type="submit"]').first().click();
  }
  await page.waitForSelector('.shell', { timeout: 20000 });
  await page.waitForTimeout(900);
}

/** Excel is not installed here, so the check is the one a reader would make. */
function readWorkbook(zipBuffer, name) {
  const entries = readZip(zipBuffer);
  const book = entries.get(name);
  if (!book) return null;
  const inner = readZip(book);
  const sheets = [];
  const workbook = inner.get('xl/workbook.xml').toString('utf8');
  for (const match of workbook.matchAll(/<sheet name="([^"]+)"/g)) sheets.push(decodeXml(match[1]));
  const first = inner.get('xl/worksheets/sheet1.xml').toString('utf8');
  const cells = [...first.matchAll(/<t xml:space="preserve">([^<]*)<\/t>/g)].map((m) => decodeXml(m[1]));
  const rtl = /rightToLeft="1"/.test(first);
  return { sheets, cells, rtl, bytes: book.length };
}

const decodeXml = (text) => text
  .replaceAll('&quot;', '"').replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');

/** A ZIP reader in twenty lines — enough to check what came out of the download. */
function readZip(buffer) {
  const entries = new Map();
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054B50) end -= 1;
  const count = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < count; i += 1) {
    const method = buffer.readUInt16LE(cursor + 10);
    const compressed = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const offset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const localName = buffer.readUInt16LE(offset + 26);
    const localExtra = buffer.readUInt16LE(offset + 28);
    const start = offset + 30 + localName + localExtra;
    const raw = buffer.subarray(start, start + compressed);
    entries.set(name, method === 0 ? raw : zlib.inflateRawSync(raw));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/* ══════════════════════════════════════════════════════════ ENGLISH, then عربي */

for (const lang of ['en', 'ar']) {
  console.log(`\n── ${lang} ──`);
  await signIn(lang);

  // 1. The fleet: who is behind, without opening a shop.
  await page.goto(`${BASE}/platform/#/tenants`);
  await page.waitForSelector('table.data tbody tr', { timeout: 20000 });
  await page.waitForTimeout(900);
  await shot(`01-shops-list-${lang}`);

  const bodyText = await page.locator('body').innerText();
  const neverWord = lang === 'ar' ? 'أبدًا' : 'Never';
  if (!bodyText.includes(neverWord)) fail(`${lang}: the shop with no backup is not marked "${neverWord}"`);
  else ok(`${lang}: the never-backed-up shop is visible from the list`);
  const overdueWord = lang === 'ar' ? 'متأخرة' : 'Overdue';
  if (!bodyText.includes(overdueWord)) fail(`${lang}: the six-day-old backup is not marked overdue`);
  else ok(`${lang}: the stale shop is flagged overdue`);
  if (!/CRON_SECRET/.test(bodyText)) fail(`${lang}: the "not armed" banner is missing`);
  else ok(`${lang}: the banner explains that nightly backups are not switched on`);

  // 2. A shop's Backups tab.
  await page.goto(`${BASE}/platform/#/tenants/mm?tab=backups`);
  await page.waitForSelector('.kpis', { timeout: 20000 });
  await page.waitForTimeout(1000);
  await shot(`02-backups-tab-${lang}`);

  // 3. Take one by hand.
  const takeButton = page.locator('.card-head .btn.primary').first();
  await takeButton.click();
  await page.waitForTimeout(2500);
  await shot(`03-after-taking-${lang}`);

  const rows = await page.locator('table.data tbody tr').count();
  if (rows < 2) fail(`${lang}: taking a backup did not add a row (${rows})`);
  else ok(`${lang}: the manual backup is in the list (${rows} rows)`);

  // 4. Download it, and open what comes out.
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.locator('table.data tbody tr').first().locator('.btn.sm').first().click(),
  ]);
  const file = path.join(OUT, `${lang}-download.zip`);
  await download.saveAs(file);
  const buffer = fs.readFileSync(file);
  console.log(`  downloaded ${download.suggestedFilename()} — ${(buffer.length / 1024).toFixed(0)} KB`);
  if (!/^mm-backup-.*\.zip$/.test(download.suggestedFilename())) {
    fail(`${lang}: the download is named "${download.suggestedFilename()}"`);
  } else ok(`${lang}: the file is named after the shop and the moment`);

  const entries = readZip(buffer);
  for (const wanted of ['README.txt', 'spreadsheets/mm-ar.xlsx', 'spreadsheets/mm-en.xlsx', 'snapshot/manifest.json']) {
    if (!entries.has(wanted)) fail(`${lang}: the download has no ${wanted}`);
  }
  ok(`${lang}: the archive holds ${entries.size} files`);

  const readme = entries.get('README.txt').toString('utf8');
  if (!readme.includes('العربية') || !readme.includes('ENGLISH')) fail(`${lang}: the README is not bilingual`);
  else ok(`${lang}: the README reads in both languages`);

  const book = readWorkbook(buffer, 'spreadsheets/mm-ar.xlsx');
  if (!book) fail(`${lang}: the Arabic workbook is missing`);
  else {
    console.log(`  Arabic workbook: ${(book.bytes / 1024).toFixed(0)} KB, tabs: ${book.sheets.join(' · ')}`);
    if (!book.rtl) fail(`${lang}: the Arabic workbook is not right-to-left`);
    else ok(`${lang}: the Arabic workbook opens right-to-left`);
    if (!book.sheets.includes('المنتجات')) fail(`${lang}: the Arabic workbook has no المنتجات tab`);
    else ok(`${lang}: its tabs are named in Arabic (${book.sheets.length} of them)`);
    if (!book.cells.includes('سعر البيع')) fail(`${lang}: the products sheet is not headed in Arabic`);
    else ok(`${lang}: the columns are headed the way the ERP names them`);
    if (!book.cells.some((cell) => /خاتم فضة/.test(cell))) fail(`${lang}: the shop's own products are not in it`);
    else ok(`${lang}: the shop's own products are in it, readable`);
  }

  const english = readWorkbook(buffer, 'spreadsheets/mm-en.xlsx');
  if (english && english.rtl) fail(`${lang}: the English workbook is right-to-left`);
  else ok(`${lang}: the English workbook reads left-to-right`);

  const manifest = JSON.parse(entries.get('snapshot/manifest.json').toString('utf8'));
  console.log(`  manifest: ${manifest.totals.rows} rows across ${manifest.tables.length} tables`);
  if (manifest.shop.slug !== 'mm') fail(`${lang}: the manifest names "${manifest.shop.slug}"`);
  else ok(`${lang}: the snapshot says which shop and which moment it is`);

  // 5. Change the shop, then restore, so the restore has something to prove.
  const marker = `WRONG-NAME-${lang}`;
  await withShop(async (db) => {
    // Rows added after the backup, which must be gone again afterwards…
    for (let i = 1; i <= 50; i += 1) {
      await db.prepare('INSERT INTO customers (code, name, phone) VALUES (?, ?, ?)')
        .run(`AFTER-${lang}-${i}`, `عميل بعد النسخة ${i}`, '0100000000');
    }
    // …a row deleted after it, which must come back…
    await db.prepare("DELETE FROM employees WHERE code = 'E-2'").run();
    // …and an edit, which must be undone.
    await db.prepare("UPDATE settings SET value = ? WHERE key = 'company.name'").run(marker);
    await db.prepare('UPDATE product_variants SET selling_price = 1 WHERE id = 1').run();
  });
  const changed = await withShop((db) => db.prepare('SELECT COUNT(*) AS n FROM customers').get().then((r) => r.n));
  console.log(`  the shop now has ${changed} clients, one employee fewer, and the wrong name`);

  await page.reload();
  await page.waitForSelector('table.data tbody tr', { timeout: 20000 });
  await page.waitForTimeout(800);
  await page.locator('table.data tbody tr').first().locator('.btn.sm.danger').first().click();
  await page.waitForSelector('.modal .danger-zone input', { timeout: 20000 });
  await page.waitForTimeout(900);
  await shot(`04-restore-plan-${lang}`);

  const dialogText = await page.locator('.modal').innerText();
  if (!dialogText.includes('290') || !dialogText.includes('240')) {
    fail(`${lang}: the plan does not show 290 clients now against 240 after`);
  } else ok(`${lang}: the plan shows what changes, in numbers (290 now → 240 after)`);

  // The button only works once the shop's own name is typed.
  const confirmButton = page.locator('.modal .modal-foot .btn.danger');
  if (!(await confirmButton.isDisabled())) fail(`${lang}: restore was enabled before the name was typed`);
  else ok(`${lang}: restore stays disabled until the shop is named`);

  await page.locator('.modal .danger-zone input').fill('not-this-shop');
  await page.waitForTimeout(250);
  await shot(`05-restore-wrong-name-${lang}`);
  if (!(await confirmButton.isDisabled())) fail(`${lang}: restore was enabled for the wrong name`);
  else ok(`${lang}: a wrong name does not enable it`);

  await page.locator('.modal .danger-zone input').fill('mm');
  await page.waitForTimeout(250);
  await shot(`06-restore-ready-${lang}`);
  await confirmButton.click();
  await page.waitForSelector('.modal', { state: 'detached', timeout: 40000 });
  await page.waitForTimeout(1200);
  await shot(`07-after-restore-${lang}`);

  const after = await withShop(async (db) => ({
    clients: (await db.prepare('SELECT COUNT(*) AS n FROM customers').get()).n,
    employees: (await db.prepare('SELECT COUNT(*) AS n FROM employees').get()).n,
    name: (await db.prepare("SELECT value AS v FROM settings WHERE key = 'company.name'").get()).v,
    price: (await db.prepare('SELECT selling_price AS p FROM product_variants WHERE id = 1').get()).p,
  }));
  if (after.clients !== 240) fail(`${lang}: after the restore the shop has ${after.clients} clients, not 240`);
  else ok(`${lang}: the 50 clients added after the backup are gone (${after.clients})`);
  if (after.employees !== 2) fail(`${lang}: the deleted employee did not come back (${after.employees})`);
  else ok(`${lang}: the deleted employee is back`);
  if (after.name === marker) fail(`${lang}: the edited setting was not restored`);
  else ok(`${lang}: the edited setting is back ("${after.name}")`);
  if (after.price === 1) fail(`${lang}: the edited price was not restored`);
  else ok(`${lang}: the edited price is back (${after.price})`);

  const status = await platformDb().prepare("SELECT status FROM tenants WHERE slug = 'mm'").get();
  if (status.status !== 'active') fail(`${lang}: the shop was left ${status.status} after a good restore`);
  else ok(`${lang}: the shop is trading again`);
}

async function openShop() {
  const row = await platformDb().prepare("SELECT * FROM tenants WHERE slug = 'mm'").get();
  return conn.openConnection({ driver: 'sqlite', file: row.db_file });
}

async function withShop(fn) {
  const c = await openShop();
  try {
    return await conn.runWithTenant({ slug: 'mm' }, c, () => fn(c.facade));
  } finally {
    await c.close();
  }
}

/* ═══════════════════════════════════════════════════════════════════ verdict */

console.log('');
for (const error of errors) console.log(`  JS  ${error}`);
console.log(`\n${failures.length ? `${failures.length} FAILURES` : 'all checks passed'}`
  + `${errors.length ? `, ${errors.length} console errors` : ''}`);
console.log('screenshots in', OUT);

await browser.close();
await new Promise((resolve) => server.close(resolve));
await conn.closeDb();
await closePlatformDb();
process.exit(failures.length || errors.length ? 1 : 0);
