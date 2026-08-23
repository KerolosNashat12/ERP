/**
 * Look at it: the staging frame on all three surfaces, and production beside it.
 *
 * Stands up one real shop on a real platform twice — once as a STAGING
 * deployment and once as a PRODUCTION one — signs into the ERP and into KJ
 * Admin, opens the storefront, and photographs each of them in both languages
 * at a desk and on a 390px phone. Twenty-four pictures, and the production half
 * of them is the control: those must show no frame at all.
 *
 * It also measures the thing the frame is not allowed to cost. On each surface
 * the document's scroll height and the position of the first real element are
 * read with the frame present and with it removed; a difference of a single
 * pixel is a failure, because the ERP is what somebody stands at a counter
 * using and this is not allowed to move anything under their hand.
 *
 * Two processes, because a deployment learns which one it is at import time —
 * which is exactly the property being photographed. The script re-runs itself
 * once per environment.
 *
 * Development aid, not part of the shipped app or of `npm test`.
 *   node tests/staging-ui-check.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.MM_SHOT_DIR || '/tmp/mm-staging-shots';

/* ───────────────────────────────────── one process per deployment, in turn */

if (!process.env.MM_DEPLOYMENT_PASS) {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  let failed = 0;
  for (const environment of ['staging', 'production']) {
    console.log(`\n════════════════════════ ${environment.toUpperCase()} ════════════════════════`);
    const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      stdio: 'inherit',
      env: {
        ...process.env,
        MM_DEPLOYMENT_PASS: '1',
        MM_DEPLOYMENT: environment,
        MM_SHOT_DIR: OUT,
      },
    });
    failed += run.status ? 1 : 0;
  }
  console.log(`\nscreenshots in ${OUT}`);
  process.exit(failed ? 1 : 0);
}

/* ──────────────────────────────────────────────────────────── one pass */

const ENVIRONMENT = process.env.MM_DEPLOYMENT;
const DATA = `/tmp/mm-staging-ui-${ENVIRONMENT}`;
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(path.join(DATA, 'tenants'), { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

process.env.MM_PLATFORM = '1';
process.env.MM_PLATFORM_DB = path.join(DATA, 'platform.db');
process.env.MM_TENANTS_DIR = path.join(DATA, 'tenants');
process.env.MM_DB_FILE = path.join(DATA, 'default.db');
process.env.MM_PLATFORM_OWNER_PASSWORD = 'staging-walkthrough-password';
process.env.MM_DEFAULT_TENANT = '';
process.env.MM_JWT_SECRET = 'staging-walkthrough-secret';
process.env.MM_FLEET_SUMMARY_ON_REQUEST = '0';

const { chromium } = await import('playwright');
const { createApp } = await import(`${HERE}/../src/server.js`);
const conn = await import(`${HERE}/../src/infrastructure/database/connection.js`);
const { initPlatformDb, closePlatformDb } = await import(`${HERE}/../src/platform/db.js`);
const tenantService = (await import(`${HERE}/../src/platform/TenantService.js`)).default;
const config = (await import(`${HERE}/../src/config/index.js`)).default;
const { MODULES } = await import(`${HERE}/../src/shared/permissions.js`);

const failures = [];
const fail = (m) => { failures.push(m); console.log(`  FAIL ${m}`); };
const ok = (m) => console.log(`  ok   ${m}`);

console.log(`  config.deployment.environment = ${config.deployment.environment} `
  + `(declared: ${config.deployment.declared})`);
if (config.deployment.environment !== ENVIRONMENT) {
  fail(`this process thinks it is ${config.deployment.environment}`);
}

await conn.initDb();
await initPlatformDb();

const SLUG = 'zamalek';
const created = await tenantService.create({
  slug: SLUG,
  nameEn: 'Zamalek Accessories',
  nameAr: 'الزمالك للإكسسوارات',
  modules: Object.keys(MODULES),
});

/** A shop with something on its shelves, and a till somebody can sign into. */
const row = await (await import(`${HERE}/../src/platform/db.js`)).platformDb()
  .prepare('SELECT * FROM tenants WHERE slug = ?').get(SLUG);
const shopConn = await conn.openConnection({ driver: 'sqlite', file: row.db_file });
await conn.runWithTenant({ slug: SLUG }, shopConn, async () => {
  await conn.transaction(async () => {
    const db = shopConn.facade;
    await db.prepare("INSERT INTO suppliers (id, code, name_en, name_ar) VALUES (1,'S-1','Cairo Gold Supply','الشركة الذهبية للتوريد')").run();
    await db.prepare("INSERT INTO brands (id, code, name_en, name_ar) VALUES (1,'AURA','Aura','أورا')").run();
    await db.prepare("INSERT INTO categories (id, code, name_en, name_ar) VALUES (1,'RING','Rings','خواتم')").run();
    for (let i = 1; i <= 12; i += 1) {
      await db.prepare(`INSERT INTO products (id, sku_prefix, name_en, name_ar, brand_id, category_id, supplier_id, unit, base_cost, base_price, is_published)
        VALUES (?,?,?,?,1,1,1,'pc',?,?,1)`).run(i, `SKU${i}`, `Silver ring ${i}`, `خاتم فضة رقم ${i}`, 60 + i, 150 + i * 2);
      await db.prepare(`INSERT INTO product_variants (id, product_id, sku, barcode, variant_label, cost_price, selling_price)
        VALUES (?,?,?,?,?,?,?)`).run(i, i, `SKU${i}-01`, `62210${String(i).padStart(8, '0')}`, 'Medium', 60 + i, 150 + i * 2);
      await db.prepare('INSERT INTO stock_levels (variant_id, warehouse_id, quantity) VALUES (?,1,?)').run(i, 20 + i);
    }
    for (let i = 1; i <= 30; i += 1) {
      const day = new Date(Date.now() - (i % 20) * 86_400_000).toISOString().slice(0, 10);
      await db.prepare(`INSERT INTO sales (id, invoice_no, warehouse_id, status, sale_date, subtotal, tax_amount, total_amount, total_cost, paid_amount, payment_method, created_by)
        VALUES (?,?,1,'completed',?,?,?,?,?,?,?,1)`)
        .run(i, `INV-${String(i).padStart(5, '0')}`, day, 180 + (i % 400), 25, 205 + (i % 400), 90 + (i % 200), 205 + (i % 400), i % 3 === 0 ? 'card' : 'cash');
    }
    // A known password, and no forced change — the point of this pass is what
    // the screen looks like, not what a first sign-in asks for.
    const bcrypt = (await import('bcryptjs')).default;
    await db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE username = 'admin'")
      .run(bcrypt.hashSync('walkthrough123', 10));
  });
});
await shopConn.close();
console.log(`  seeded ${SLUG} (console owner password set, admin password reset from ${created.adminPassword ? 'generated' : 'adopted'})`);

const server = await new Promise((resolve) => {
  const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
});
const BASE = `http://127.0.0.1:${server.address().port}`;
console.log(`  server on ${BASE}`);

/* ─────────────────────────────────────────────────────────────── the browser */

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const EXPECTED = [/\b401\b/, /Failed to fetch/, /did not answer/];

const SIZES = [
  ['desktop', { width: 1440, height: 900 }],
  ['390', { width: 390, height: 844 }],
];

/** Does the frame exist, and is it inert? */
const probeFrame = (page) => page.evaluate(() => {
  const root = document.getElementById('mm-deployment');
  if (!root) return null;
  const style = getComputedStyle(root);
  const flag = root.querySelector('.mm-dep-f');
  return {
    env: root.dataset.env,
    position: style.position,
    pointerEvents: style.pointerEvents,
    zIndex: style.zIndex,
    text: flag ? flag.textContent : '',
    title: document.title,
  };
});

/**
 * What the frame costs the page: nothing, or a number.
 *
 * Measured rather than asserted — the frame is removed, the same three
 * quantities are read again, and the two readings must be identical.
 */
const probeCost = (page) => page.evaluate(() => {
  const anchor = document.querySelector('.topbar, .site-head, .rail, .login-card, main, body > *');
  const read = () => {
    const box = anchor.getBoundingClientRect();
    return {
      scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth,
      top: Math.round(box.top),
      left: Math.round(box.left),
      width: Math.round(box.width),
    };
  };
  const before = read();
  const root = document.getElementById('mm-deployment');
  if (!root) return { before, after: before, removed: false };
  root.remove();
  const after = read();
  document.body.appendChild(root);
  return { before, after, removed: true };
});

async function shot(page, name) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  console.log('  shot', name);
}

/** One surface, one language, one size. */
async function visit({ surface, lang, size, viewport, open }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    if (EXPECTED.some((p) => p.test(msg.text()))) return;
    errors.push(`[console] ${surface}/${lang}: ${msg.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${surface}/${lang}: ${e.message}`));

  await open(page, lang);
  const frame = await probeFrame(page);
  const cost = await probeCost(page);
  await shot(page, `${surface}-${ENVIRONMENT}-${lang}-${size}`);

  const label = `${surface} ${lang} ${size}`;
  if (ENVIRONMENT === 'production') {
    if (frame) fail(`${label}: production is carrying a frame`);
    else ok(`${label}: production shows nothing`);
    if (/^\[/.test(frame?.title || '')) fail(`${label}: production's tab title is prefixed`);
  } else {
    if (!frame) fail(`${label}: no frame on staging`);
    else {
      if (frame.position !== 'fixed') fail(`${label}: frame is ${frame.position}, not fixed`);
      if (frame.pointerEvents !== 'none') fail(`${label}: frame can swallow a click`);
      if (!frame.text.trim()) fail(`${label}: the flag has no words`);
      if (!frame.title.startsWith('[')) fail(`${label}: the tab title is not prefixed — "${frame.title}"`);
      else ok(`${label}: "${frame.text}" · tab "${frame.title.slice(0, 40)}"`);
    }
    if (cost.removed) {
      const drift = Object.keys(cost.before).filter((k) => cost.before[k] !== cost.after[k]);
      if (drift.length) fail(`${label}: the frame moved the page — ${drift.map((k) => `${k} ${cost.before[k]}→${cost.after[k]}`).join(', ')}`);
      else ok(`${label}: costs 0px — scroll height, width and the first element are identical without it`);
    }
  }

  const dir = await page.evaluate(() => document.documentElement.dir);
  if (dir !== (lang === 'ar' ? 'rtl' : 'ltr')) fail(`${label}: direction is "${dir}"`);
  await context.close();
}

const openErp = async (page, lang) => {
  await page.goto(`${BASE}/t/${SLUG}/`);
  await page.evaluate((l) => localStorage.setItem('mm.lang', l), lang);
  await page.reload();
  await page.waitForSelector('.login-card, .shell', { timeout: 30000 });
  if (await page.locator('input[name=username]').isVisible().catch(() => false)) {
    await page.fill('input[name=username]', 'admin');
    await page.fill('input[name=password]', 'walkthrough123');
    await page.click('button[type=submit]');
  }
  await page.waitForSelector('.shell', { timeout: 30000 });
  await page.waitForTimeout(1200);
};

const openConsole = async (page, lang) => {
  await page.goto(`${BASE}/platform/`);
  await page.evaluate((l) => localStorage.setItem('mm.platform.lang', l), lang);
  await page.reload();
  await page.waitForSelector('.shell, input[name="username"]', { timeout: 30000 });
  if (await page.locator('input[name="username"]').isVisible().catch(() => false)) {
    await page.fill('input[name="username"]', 'owner');
    await page.fill('input[name="password"]', 'staging-walkthrough-password');
    await page.locator('button[type="submit"]').first().click();
  }
  await page.waitForSelector('.shell', { timeout: 30000 });
  await page.waitForTimeout(1200);
};

const openShop = async (page, lang) => {
  await page.goto(`${BASE}/t/${SLUG}/shop`);
  await page.evaluate((l) => localStorage.setItem('mm.shop.lang', l), lang);
  await page.reload();
  await page.waitForSelector('.site-head', { timeout: 30000 });
  await page.waitForTimeout(1200);
};

for (const [size, viewport] of SIZES) {
  for (const lang of ['en', 'ar']) {
    console.log(`\n── ${size} · ${lang} ──`);
    await visit({ surface: 'erp', lang, size, viewport, open: openErp });
    await visit({ surface: 'console', lang, size, viewport, open: openConsole });
    await visit({ surface: 'shop', lang, size, viewport, open: openShop });
  }
}

console.log('\n──────────────────────────────────────────────');
for (const e of errors) console.log('  ERR', e);
console.log(`${ENVIRONMENT}: ${failures.length ? `${failures.length} FAILURES` : 'all checks passed'}`
  + `${errors.length ? `, ${errors.length} console errors` : ''}`);

await browser.close();
await new Promise((resolve) => server.close(resolve));
await conn.closeDb();
await closePlatformDb();
process.exit(failures.length || errors.length ? 1 : 0);
