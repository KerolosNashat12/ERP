/**
 * The overview at eighty shops, before and after.
 *
 * Stands up a real fleet — six shops, then eighty — signs into KJ Admin, and
 * measures the landing screen both ways: computed live by opening every shop
 * (what this console did until now, still reachable as `?live=1`), and read
 * from the summary table (what it does now). Both numbers that matter are
 * measured rather than asserted: how long the request takes, and how many shop
 * databases it opens, which `/api/health` reports as a cumulative counter so
 * the difference across a page load is exactly that page load's cost.
 *
 * Then it photographs the screen in English and in Arabic, in both modes, plus
 * the three states the freshness furniture exists for: a stale shop, a shop
 * nobody has measured, and a shop whose database has gone.
 *
 * Development aid, not part of the shipped app or of `npm test`.
 *   node tests/fleet-ui-check.mjs            # 80 shops
 *   MM_FLEET_SHOPS=6 node tests/fleet-ui-check.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const SHOP_COUNT = Number(process.env.MM_FLEET_SHOPS || 80);
const OUT = process.env.MM_SHOT_DIR || `/tmp/mm-fleet-shots-${SHOP_COUNT}`;
const DATA = `/tmp/mm-fleet-ui-data-${SHOP_COUNT}`;
fs.rmSync(OUT, { recursive: true, force: true });
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.join(DATA, 'tenants'), { recursive: true });

process.env.MM_PLATFORM = '1';
process.env.MM_PLATFORM_DB = path.join(DATA, 'platform.db');
process.env.MM_TENANTS_DIR = path.join(DATA, 'tenants');
process.env.MM_DB_FILE = path.join(DATA, 'default.db');
process.env.MM_PLATFORM_OWNER_PASSWORD = 'fleet-walkthrough-password';
process.env.MM_DEFAULT_TENANT = '';
process.env.MM_JWT_SECRET = 'fleet-walkthrough-secret';
// Every shop's figures must be readable in one go for the "after" measurement
// to mean anything; the sweep is driven by hand below.
process.env.CRON_SECRET = 'fleet-walkthrough-cron';

const { createApp } = await import('../src/server.js');
const conn = await import('../src/infrastructure/database/connection.js');
const { initPlatformDb, platformDb, closePlatformDb } = await import('../src/platform/db.js');
const tenantService = (await import('../src/platform/TenantService.js')).default;
const summaries = (await import('../src/platform/FleetSummaryService.js')).default;
const connectionCache = await import('../src/infrastructure/database/connections.js');
const { MODULES } = await import('../src/shared/permissions.js');

await conn.initDb();
await initPlatformDb();

const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`  FAIL ${msg}`); };
const ok = (msg) => console.log(`  ok   ${msg}`);

/* ─────────────────────────────────────────────────────────────── the fleet */

const CITIES = [
  ['Zamalek', 'الزمالك'], ['Nasr City', 'مدينة نصر'], ['Tanta', 'طنطا'], ['Maadi', 'المعادي'],
  ['Heliopolis', 'مصر الجديدة'], ['Alexandria', 'الإسكندرية'], ['Giza', 'الجيزة'], ['Mansoura', 'المنصورة'],
  ['Aswan', 'أسوان'], ['Luxor', 'الأقصر'], ['Port Said', 'بورسعيد'], ['Suez', 'السويس'],
];

const shops = Array.from({ length: SHOP_COUNT }, (_, i) => {
  const [en, ar] = CITIES[i % CITIES.length];
  const n = Math.floor(i / CITIES.length) + 1;
  return {
    slug: `shop-${String(i + 1).padStart(2, '0')}`,
    en: `${en} Accessories ${n}`,
    ar: `${ar} للإكسسوارات ${n}`,
    products: 20 + (i % 25),
    sales: 25 + (i % 60),
  };
});

async function fill(shop) {
  const row = await platformDb().prepare('SELECT * FROM tenants WHERE slug = ?').get(shop.slug);
  const c = await conn.openConnection({ driver: 'sqlite', file: row.db_file });
  await conn.runWithTenant({ slug: shop.slug }, c, async () => {
    await conn.transaction(async () => {
      const db = c.facade;
      await db.prepare("INSERT INTO suppliers (id, code, name_en, name_ar) VALUES (1,'S-1','Cairo Gold Supply','الشركة الذهبية للتوريد')").run();
      await db.prepare("INSERT INTO brands (id, code, name_en, name_ar) VALUES (1,'AURA','Aura','أورا')").run();
      await db.prepare("INSERT INTO categories (id, code, name_en, name_ar) VALUES (1,'RING','Rings','خواتم')").run();
      for (let i = 1; i <= shop.products; i += 1) {
        await db.prepare(`INSERT INTO products (id, sku_prefix, name_en, name_ar, brand_id, category_id, supplier_id, unit, base_cost, base_price)
          VALUES (?,?,?,?,1,1,1,'pc',?,?)`).run(i, `SKU${i}`, `Silver ring ${i}`, `خاتم فضة رقم ${i}`, 60 + i, 150 + i * 2);
        await db.prepare(`INSERT INTO product_variants (id, product_id, sku, barcode, variant_label, cost_price, selling_price)
          VALUES (?,?,?,?,?,?,?)`).run(i, i, `SKU${i}-01`, `62210${String(i).padStart(8, '0')}`, 'Medium', 60 + i, 150 + i * 2);
      }
      for (let i = 1; i <= shop.sales; i += 1) {
        const day = new Date(Date.now() - (i % 28) * 86_400_000).toISOString().slice(0, 10);
        await db.prepare(`INSERT INTO sales (id, invoice_no, warehouse_id, status, sale_date, subtotal, tax_amount, total_amount, total_cost, paid_amount, payment_method, created_by)
          VALUES (?,?,1,'completed',?,?,?,?,?,?,?,1)`)
          .run(i, `INV-${String(i).padStart(5, '0')}`, day, 180 + (i % 400), 25, 205 + (i % 400), 90 + (i % 200), 205 + (i % 400), i % 3 === 0 ? 'card' : 'cash');
        await db.prepare(`INSERT INTO sale_lines (id, sale_id, variant_id, sku, description, quantity, unit_price, unit_cost, tax_rate, tax_amount, line_total)
          VALUES (?,?,?,?,?,?,?,?,14,?,?)`)
          .run(i, i, 1 + (i % shop.products), `SKU${1 + (i % shop.products)}-01`, `خاتم فضة رقم ${1 + (i % shop.products)}`,
            1 + (i % 3), 150 + (i % 120), 60 + (i % 60), 25, 205 + (i % 400));
      }
    });
  });
  await c.close();
}

console.log(`\nseeding ${SHOP_COUNT} shops…`);
const seedStart = Date.now();
for (const shop of shops) {
  await tenantService.create({ slug: shop.slug, nameEn: shop.en, nameAr: shop.ar, modules: Object.keys(MODULES) });
  await fill(shop);
  if (shops.indexOf(shop) % 10 === 9) console.log(`  ${shops.indexOf(shop) + 1}/${SHOP_COUNT}`);
}
console.log(`  seeded in ${((Date.now() - seedStart) / 1000).toFixed(1)}s`);

/**
 * Three shops put into the three states the console has to be honest about,
 * so the screenshots show the real thing rather than a description of it.
 * Chosen from the tail so the busiest shops still fill the top of the table.
 */
const staleShop = shops.at(-1).slug;
const goneShop = shops.at(-2).slug;
const neverShop = shops.at(-3).slug;

const app = createApp();
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const BASE = `http://127.0.0.1:${server.address().port}`;
console.log(`  server on ${BASE}`);

/* ───────────────────────────────────────────────────────── the measurement */

let cookie = '';
async function call(urlPath, options = {}) {
  const res = await fetch(`${BASE}${urlPath}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
      'Idempotency-Key': `m-${Math.random().toString(36).slice(2)}`,
      ...(options.headers || {}),
    },
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => null) };
}

await call('/api/platform/auth/login', {
  method: 'POST',
  body: JSON.stringify({ username: 'owner', password: 'fleet-walkthrough-password' }),
});

const connections = async () => (await call('/api/health')).data.connections.opened;

/**
 * One measured request: wall time, and shop databases opened while it ran.
 *
 * Every run starts from a closed connection cache, because that is what a page
 * load on this deployment actually is. Serverless instances are cold far more
 * often than they are warm, and the cache holds 25 connections against a fleet
 * of eighty — so measuring a warm process would flatter the fan-out with
 * connections a real page load would have had to make.
 */
async function measure(label, urlPath, runs = 3) {
  const times = [];
  let opened = 0;
  for (let i = 0; i < runs; i += 1) {
    await connectionCache.closeAll();
    const before = await connections();
    const started = Date.now();
    const res = await call(urlPath);
    times.push(Date.now() - started);
    const cost = (await connections()) - before;
    if (i === runs - 1) opened = cost;
    if (res.status !== 200) fail(`${label}: ${urlPath} answered ${res.status}`);
  }
  const median = [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)];
  console.log(`  ${label.padEnd(34)} ${String(median).padStart(6)} ms   ${String(opened).padStart(3)} database(s) opened`);
  return { label, median, opened, times };
}

console.log(`\n── ${SHOP_COUNT} shops · GET /api/platform/overview ──`);
// BEFORE: the fan-out this console used to do on every page load.
const before = await measure('before  (fan-out, ?live=1)', '/api/platform/overview?live=1');
// Fill the summary table the way the hourly sweep does.
const sweepStart = Date.now();
const sweep = await fetch(`${BASE}/api/cron/summaries`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
const sweepBody = await sweep.json();
console.log(`  the hourly sweep read ${sweepBody.ran} shop(s) in ${((Date.now() - sweepStart) / 1000).toFixed(1)}s `
  + `(${sweepBody.remaining} left for the next run)`);
// AFTER: one control-plane read.
const after = await measure('after   (summaries)       ', '/api/platform/overview');

/**
 * And the one case in between: the very first load after this ships, when no
 * shop has been measured yet. The page backfills at most `MM_FLEET_BACKFILL_MAX`
 * shops (8 by default) and shows the rest honestly as "not measured yet", so
 * even that load is bounded — it can never be one connection per shop.
 */
await platformDb().prepare('DELETE FROM tenant_summaries').run();
const cold = await measure('after   (first load, empty table)', '/api/platform/overview', 1);
if (cold.opened > 8) fail(`the first load opened ${cold.opened} databases — the cap is 8`);
else ok(`a fleet with nothing measured costs ${cold.opened} connections, not ${SHOP_COUNT}`);
await fetch(`${BASE}/api/cron/summaries`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });

if (after.opened !== 0) fail(`the summary read opened ${after.opened} database(s) — it must open none`);
else ok('the overview opens no shop database at all');
if (before.opened < SHOP_COUNT) fail(`the fan-out opened ${before.opened}, expected ${SHOP_COUNT}`);
else ok(`the fan-out really does open one database per shop (${before.opened})`);

/* ──────────────────────────────────────────── the three states, for the shots */

/**
 * The page normally backfills a never-measured shop the first time it is asked
 * for, so on a six-shop fleet the "not measured yet" row would fill itself in
 * before it could be photographed. Switched off from here on, which is exactly
 * the state of every shop past the cap on a fleet that has just been
 * provisioned — the row on screen is the real one, not a mock-up of it.
 */
process.env.MM_FLEET_BACKFILL_MAX = '0';

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
await platformDb().prepare('UPDATE tenant_summaries SET computed_at = ?, attempted_at = ? WHERE slug = ?')
  .run(daysAgo(1), daysAgo(1), staleShop);
await platformDb().prepare('DELETE FROM tenant_summaries WHERE slug = ?').run(neverShop);
await platformDb().prepare('UPDATE tenants SET db_file = ? WHERE slug = ?')
  .run('/no/such/directory/on/this/machine/gone.db', goneShop);
// The sweep left this shop's connection open, and a cached connection does not
// care that the row now points somewhere else — without this the "unreachable"
// shop reads perfectly well and the state never appears on screen.
await connectionCache.forget(goneShop);
await summaries.refreshShop(
  await platformDb().prepare('SELECT * FROM tenants WHERE slug = ?').get(goneShop),
  { source: 'cron' },
);
console.log(`\n  states on screen: ${staleShop} stale · ${neverShop} never measured · ${goneShop} unreachable`);

/* ─────────────────────────────────────────────────────────────── the browser */

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
const page = await context.newPage();

/**
 * How the "before" screenshots are taken.
 *
 * `page.route(...).continue({ url })` looked like the obvious way to send the
 * console's overview request to `?live=1` — and it silently did nothing, which
 * the connection count in `timeOverview` caught. This patches `fetch` inside
 * the page instead, gated on a flag in localStorage so the same page can be
 * driven both ways. The console's own code is untouched: it asks for
 * `/overview`, and what it gets back is the fan-out this screen used to do.
 */
/**
 * How the "before" screenshots are taken.
 *
 * The console asks for `/api/platform/overview`; during the "before" pass that
 * request is answered from `?live=1` instead — the fan-out this screen used to
 * do, through the real server, on the real fleet. The page's own code is
 * untouched.
 *
 * Two earlier attempts at this are worth recording, because both looked right
 * and both silently measured nothing: `route.continue({ url })` did not rewrite
 * the URL at all, and a patched `window.fetch` missed it because the console
 * passes a `URL` object rather than a string. Neither would have been noticed
 * without the connection count in `timeOverview` — a "before" number that is
 * really an "after" number is the most flattering possible way to be wrong.
 */
/**
 * A predicate rather than a glob. Playwright's URL glob matching has changed
 * shape more than once and `'**\/api/platform/overview'` matched nothing here;
 * a function cannot be wrong about what it matches.
 */
const LIVE_ROUTE = (url) => url.pathname === '/api/platform/overview';
const liveHandler = async (route) => {
  if (process.env.MM_FLEET_TRACE) console.log('   [route] intercepted', route.request().url());
  const upstream = await fetch(`${BASE}/api/platform/overview?live=1`, { headers: { cookie } });
  await route.fulfill({
    status: upstream.status,
    contentType: 'application/json',
    body: await upstream.text(),
  });
};

const errors = [];
/**
 * Three failures this walkthrough causes itself and must not blame the app for:
 * the pre-login `/auth/me` probe answers 401 by design, and navigating to
 * `about:blank` between measurements aborts whatever request the previous
 * screen had in the air — which the console reports as its own network error.
 */
const EXPECTED = [/\b401\b/, /The server did not answer/, /Failed to fetch/];
page.on('console', (msg) => {
  if (msg.type() !== 'error') return;
  if (EXPECTED.some((p) => p.test(msg.text()))) return;
  errors.push(`[console] ${msg.text()} @ ${page.url()}`);
});
page.on('pageerror', (error) => errors.push(`[pageerror] ${error.message}`));
if (process.env.MM_FLEET_TRACE) {
  page.on('request', (r) => { if (r.url().includes('/overview')) console.log('   >>', r.url()); });
}

const shot = async (name) => {
  await page.waitForTimeout(400);
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
    await page.locator('input[name="password"]').fill('fleet-walkthrough-password');
    await page.locator('button[type="submit"]').first().click();
  }
  await page.waitForSelector('.shell', { timeout: 20000 });
}

/** How long the OVERVIEW SCREEN takes, from navigation to a drawn table. */
async function timeOverview(mode) {
  await page.unroute(LIVE_ROUTE, liveHandler).catch(() => {});
  if (mode === 'live') await page.route(LIVE_ROUTE, liveHandler);

  /**
   * `about:blank` first, and it is not a nicety.
   *
   * The console is a hash router and the shell opens on `#/overview`, so
   * `page.goto('…#/overview')` from that same address is a same-document
   * navigation: nothing re-renders, nothing is fetched, and the timer measures
   * a screen that was already on screen. The first version of this measured
   * exactly that and reported a "before" of 30ms — with zero connections
   * opened, which is the only reason it was caught.
   *
   * Starting from a blank page makes every measurement a real document load:
   * HTML, modules, session probe and the overview request, which is what
   * "how long does this page take" means to the person waiting for it.
   */
  await page.goto('about:blank');
  await connectionCache.closeAll();
  const opened = connectionCache.totalOpened();
  const started = Date.now();
  await page.goto(`${BASE}/platform/#/overview`);
  // The shops table's own row button — the thirty-day table underneath the
  // chart is collapsed, so waiting on any `table.data` row waits forever.
  await page.waitForSelector('.row-actions .btn', { timeout: 120000 });
  const elapsed = Date.now() - started;
  const cost = connectionCache.totalOpened() - opened;
  await page.waitForTimeout(700);
  /**
   * The connection count is the check, not the decoration: without it a
   * mis-wired route rewrite would quietly measure the summary path twice and
   * report a flattering "before" that never happened.
   */
  if (mode === 'live' && cost < SHOP_COUNT) {
    fail(`the "before" page load opened ${cost} databases, not ${SHOP_COUNT} — it did not use the fan-out`);
  }
  if (mode !== 'live' && cost !== 0) {
    fail(`the "after" page load opened ${cost} databases — it must open none`);
  }
  return { elapsed, cost };
}

const results = [];
for (const lang of ['en', 'ar']) {
  console.log(`\n── ${lang} ──`);
  await signIn(lang);

  const live = await timeOverview('live');
  await shot(`overview-before-${SHOP_COUNT}-${lang}`);
  console.log(`  before: overview drawn in ${live.elapsed} ms · ${live.cost} database(s) opened`);

  const summary = await timeOverview('summaries');
  await shot(`overview-after-${SHOP_COUNT}-${lang}`);
  // The table itself, where the per-row freshness lives: the "last read"
  // column, and the tags on the three shops that are not simply fine.
  await page.locator('.row-actions .btn').first().scrollIntoViewIfNeeded();
  await shot(`overview-table-${SHOP_COUNT}-${lang}`);
  console.log(`  after:  overview drawn in ${summary.elapsed} ms · ${summary.cost} database(s) opened`);
  results.push({ lang, liveMs: live.elapsed, liveCost: live.cost, summaryMs: summary.elapsed, summaryCost: summary.cost });

  /**
   * Lower-cased before matching: `innerText` gives back what is RENDERED, and
   * several of these labels are `text-transform: uppercase` in the stylesheet.
   * (Which is why the Arabic pass found them and the English one did not, the
   * first time this was run — Arabic has no upper case.)
   */
  const body = (await page.locator('body').innerText()).toLowerCase();
  const words = lang === 'ar'
    ? { stale: 'قديمة', never: 'لم تُقرأ بعد', gone: 'غير متاح', refresh: 'حدّث الآن' }
    : { stale: 'Stale', never: 'Not measured yet', gone: 'Unreachable', refresh: 'Refresh now' };

  // The words alone are not enough: "unreachable" is also a permanent label in
  // the metric strip, so the COUNT beside it is what proves the state is real.
  const counted = await page.evaluate(() => {
    const strip = [...document.querySelectorAll('.metric')];
    const read = (i) => Number((strip[i]?.querySelector('b')?.textContent || '0').replace(/[^0-9]/g, ''));
    return { unreachable: read(3), notMeasured: read(4), tags: document.querySelectorAll('.tag.danger, .tag.warn').length };
  });
  if (counted.unreachable !== 1) fail(`${lang}: the strip counts ${counted.unreachable} unreachable shops, expected 1`);
  else ok(`${lang}: the unreachable shop is counted, not just labelled`);
  if (counted.notMeasured !== 1) fail(`${lang}: the strip counts ${counted.notMeasured} unmeasured shops, expected 1`);
  else ok(`${lang}: the never-measured shop is counted`);
  if (counted.tags < 3) fail(`${lang}: only ${counted.tags} state tags are on the rows, expected 3`);
  else ok(`${lang}: every flagged shop carries its tag on its own row`);
  for (const [key, word] of Object.entries(words)) {
    if (!body.includes(word.toLowerCase())) fail(`${lang}: "${word}" (${key}) is not on the overview`);
    else ok(`${lang}: the ${key} state reads "${word}"`);
  }

  const dir = await page.evaluate(() => document.documentElement.dir);
  if (dir !== (lang === 'ar' ? 'rtl' : 'ltr')) fail(`${lang}: the page direction is "${dir}"`);
  else ok(`${lang}: the page reads ${dir}`);

  // The Shops screen reads the same summaries, and must not invent counts for
  // the shop nobody has measured.
  await page.goto(`${BASE}/platform/#/tenants`);
  await page.waitForSelector('table.data tbody tr', { timeout: 60000 });
  await page.waitForTimeout(700);
  await shot(`shops-after-${SHOP_COUNT}-${lang}`);
}

/* ═══════════════════════════════════════════════════════════════════ verdict */

console.log('\n──────────────────────────────────────────────────────────────');
console.log(` ${SHOP_COUNT} shops`);
console.log(`   API   before ${String(before.median).padStart(6)} ms · ${String(before.opened).padStart(3)} connections`);
console.log(`   API   after  ${String(after.median).padStart(6)} ms · ${String(after.opened).padStart(3)} connections`);
for (const r of results) {
  console.log(`   page  ${r.lang}  before ${String(r.liveMs).padStart(6)} ms · ${String(r.liveCost).padStart(3)} conn`
    + `   after ${String(r.summaryMs).padStart(6)} ms · ${String(r.summaryCost).padStart(3)} conn`);
}
console.log('──────────────────────────────────────────────────────────────');
for (const error of errors) console.log(`  JS  ${error}`);
for (const e of errors) console.log('  ERR', e);
console.log(`${failures.length ? `${failures.length} FAILURES` : 'all checks passed'}`
  + `${errors.length ? `, ${errors.length} console errors` : ''}`);
console.log('screenshots in', OUT);

await browser.close();
await new Promise((resolve) => server.close(resolve));
await conn.closeDb();
await closePlatformDb();
process.exit(failures.length || errors.length ? 1 : 0);
