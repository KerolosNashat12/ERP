/**
 * THE BANNER AND THE FIGURES UNDER IT.
 *
 * The owner sent a reference and said «عاوزين البانر زي كدا واللاحصائيات اللي
 * تحت» — this banner, and the figures below it. The banner half is typography;
 * the figures half is a set of CLAIMS a shop makes to its customers on its own
 * front page, and that is what most of this file is about.
 *
 * The reference prints "387+ PRODUCTS · 45+ BRANDS · Free SHIPPING". The
 * tempting reading is that those are decoration. They are not: a shopper reads
 * them as facts about the shop they are standing in. So every one of them is
 * counted from this shop's catalogue, the rounding is only ever DOWNWARDS, and
 * "Free shipping" is printed only by a shop that actually gives it.
 */
import './single-shop.js'; // must be first — see that file
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'data', 'hero-test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
process.env.MM_DB_FILE = path.join(dir, 'shop.db');

const { createApp } = await import('../src/server.js');
const { initDb, closeDb, applySchema } = await import('../src/infrastructure/database/connection.js');
const { seedBaseline } = await import('../src/infrastructure/database/seed.js');
const { runMigrations } = await import('../src/infrastructure/database/migrations/index.js');

let base = '';
let cookie = '';

async function call(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
      'Idempotency-Key': `hs-${Math.random().toString(36).slice(2)}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
const ok = async (p, o) => {
  const res = await call(p, o);
  assert.ok(res.status < 400, `${p} → ${res.status} ${JSON.stringify(res.data).slice(0, 250)}`);
  return res.data;
};
const settings = (values) => ok('/api/settings', { method: 'PUT', body: values });
const stats = async () => (await ok('/api/shop/home')).stats;

test('the banner and the figures under it', async (t) => {
  await initDb();
  await applySchema();
  await seedBaseline();
  await runMigrations();

  const server = await new Promise((resolve) => {
    const listening = http.createServer(createApp()).listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  cookie = (await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  }).then((r) => r.headers.get('set-cookie'))).split(';')[0];

  /* ═══════════════════════════════════ the strip is a choice, not a default ══ */

  await t.test('a shop that has not asked for the figures does not get them', async () => {
    /*
     * The default is OFF and that is a judgement, not an oversight. The band
     * announces how many products a shop carries; that reads as confidence at
     * 250 and as an apology at 11, and this platform sells to both. Nobody's
     * front page changes because an update landed.
     */
    assert.equal(await stats(), null);
  });

  await t.test('switching it on produces figures counted from the catalogue', async () => {
    await settings({ 'web.stats_enabled': '1' });
    const found = await stats();
    assert.ok(found, 'the strip stayed off after being switched on');
    assert.equal(typeof found.products, 'number');
    assert.equal(typeof found.brands, 'number');
  });

  await t.test('the count follows the catalogue, both ways', async () => {
    const before = await stats();

    const brand = await ok('/api/brands', { method: 'POST', body: { name_en: 'Counted Brand', name_ar: 'ماركة' } });
    const made = await ok('/api/products', {
      method: 'POST',
      body: {
        sku_prefix: 'CNT-1', name_en: 'Counted Product', name_ar: 'منتج', base_price: 100,
        brand_id: brand.id, is_published: 1,
        variants: [{ sku: 'CNT-1-A', cost_price: 10, selling_price: 100 }],
      },
    });
    const after = await stats();
    assert.equal(after.products, before.products + 1, 'a new product did not reach the figure');
    assert.equal(after.brands, before.brands + 1, 'a new brand did not reach the figure');

    /*
     * And UNPUBLISHING must take it back out. The number is shown to shoppers
     * beside a shelf they can browse, so counting something they cannot reach
     * is the figure telling them the shop is bigger than it is.
     */
    await ok(`/api/products/${made.id}`, {
      method: 'PUT',
      body: {
        sku_prefix: 'CNT-1', name_en: 'Counted Product', name_ar: 'منتج', base_price: 100,
        brand_id: brand.id, is_published: 0,
        variants: [{ id: made.variants[0].id, sku: 'CNT-1-A', cost_price: 10, selling_price: 100 }],
      },
    });
    const hidden = await stats();
    assert.equal(hidden.products, before.products,
      'an unpublished product is still counted on the shop front');
    assert.equal(hidden.brands, before.brands,
      'a brand with nothing published under it is still counted');
  });

  /* ═════════════════════════════════════════ delivery is what the shop charges ══ */

  await t.test('"Free shipping" is only sent by a shop that gives it', async () => {
    /*
     * The reference says "Free SHIPPING". Printing that over a shop that
     * charges 50 EGP is a promise the checkout then breaks, and the customer
     * finds out on the last screen. Each shape is a different sentence on the
     * page, so each is checked here rather than trusting one flag.
     */
    await settings({ 'shop.delivery_mode': 'flat', 'shop.delivery_fee': 0, 'shop.free_delivery_over': 0 });
    let d = (await stats()).delivery;
    assert.equal(d.alwaysFree, true, 'a shop charging nothing does not read as free');

    await settings({ 'shop.delivery_fee': 50 });
    d = (await stats()).delivery;
    assert.equal(d.alwaysFree, false, 'a shop charging 50 still reads as free delivery');
    assert.equal(d.flat, 50, 'the amount the page would print is wrong');

    await settings({ 'shop.free_delivery_over': 1500 });
    d = (await stats()).delivery;
    assert.equal(d.freeOver, 1500);
    assert.equal(d.alwaysFree, false, 'free OVER a threshold is not free');

    await settings({ 'shop.delivery_mode': 'percent', 'shop.delivery_percent': 8 });
    d = (await stats()).delivery;
    assert.equal(d.mode, 'percent');
    assert.equal(d.percent, 8);
  });

  /* ═════════════════════════════════════════════════════ the second button ══ */

  await t.test('the second button appears only when the shop configures one', async () => {
    let banner = (await ok('/api/shop/config')).banner;
    assert.equal(banner.cta2, null, 'a shop that configured no second button has one');

    await settings({
      'web.banner_cta2_label_en': 'Our Story',
      'web.banner_cta2_label_ar': 'قصتنا',
      'web.banner_cta2_link': 'contact',
    });
    banner = (await ok('/api/shop/config')).banner;
    assert.equal(banner.cta2.label.en, 'Our Story');
    assert.equal(banner.cta2.label.ar, 'قصتنا');
    assert.equal(banner.cta2.link, 'contact');

    // The first button is untouched by any of it.
    await settings({ 'web.banner_cta_label_en': 'Explore', 'web.banner_cta_link': 'products' });
    banner = (await ok('/api/shop/config')).banner;
    assert.equal(banner.cta.label.en, 'Explore');
    assert.equal(banner.cta2.label.en, 'Our Story');
  });

  await t.test('a half-filled second button still produces one', async () => {
    // A shop that typed a label and forgot the link should get a button, not
    // silence — silence gives it no way to tell which of three fields was wrong.
    await settings({
      'web.banner_cta2_label_en': 'Read more', 'web.banner_cta2_label_ar': '', 'web.banner_cta2_link': '',
    });
    const banner = (await ok('/api/shop/config')).banner;
    assert.ok(banner.cta2, 'a label with no link produced no button at all');
  });

  await t.test('the heading keeps the line breaks the shop typed', async () => {
    /*
     * The whole banner design rests on this: the storefront leans the SECOND
     * line. A settings layer that trimmed or collapsed newlines would leave the
     * shop no way to say where a line ends, and the feature would silently be
     * a one-line heading again.
     */
    await settings({ 'web.banner_heading_en': 'Accessories\nThat Define\nYour Essence' });
    const banner = (await ok('/api/shop/config')).banner;
    assert.equal(banner.heading.en.split('\n').length, 3,
      `line breaks did not survive: ${JSON.stringify(banner.heading.en)}`);
  });

  await t.test('an unknown value for the switch is refused where somebody is looking', async () => {
    for (const bad of ['yes please', '2', 'maybe', 'on;drop']) {
      const res = await call('/api/settings', { method: 'PUT', body: { 'web.stats_enabled': bad } });
      assert.ok(res.status >= 400, `"${bad}" was accepted as an on/off value`);
    }
    // …and the shop is still on its last good value rather than on nothing.
    assert.ok(await stats(), 'a refused write turned the strip off');
  });
});

/* ══════════════════════════════ the heading, as the browser will build it ══ */

test('the heading is split into lines, and cannot carry markup', async () => {
  /*
   * `headingLines()` is not exported — it is an implementation detail of the
   * home view — so what is fenced here is the property that makes it SAFE,
   * read off the source: it must build elements, and it must never reach for
   * innerHTML.
   *
   * This matters more than it looks. The banner heading is text a shop owner
   * types, rendered on the most visible pixel of a page served to the open
   * internet. Getting one `<em>` by assigning innerHTML would put an injection
   * point on every shop on the platform — and it is the obvious way to write
   * this, which is exactly why it is worth a test.
   */
  const source = fs.readFileSync(path.join(here, '..', 'public/shop/js/views/home.js'), 'utf8');
  const fn = source.slice(source.indexOf('function headingLines'), source.indexOf('function statsStrip'));
  assert.ok(fn.length > 200, 'headingLines was not found — this test is checking nothing');
  /*
   * `html:` is the one that matters, and it is the one the first draft of this
   * test missed. In this codebase the injection vector is not a literal
   * `innerHTML` — `el()` accepts an `html` prop and assigns innerHTML from it
   * (see core/dom.js, "only ever called with our own markup"). A test that
   * only looked for the word `innerHTML` passed happily while the reversion
   * check fed the shop's own heading straight into it.
   */
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|\bhtml\s*:/.test(fn),
    'the heading is built from markup, so a shop could inject script into its own banner');
  assert.match(fn, /em\.hero-line/, 'the second line is not emphasised');
  assert.match(fn, /split\(/, 'the heading is not split into lines at all');

  /*
   * And the DOM helper it builds through appends TEXT NODES, which is what
   * makes the above enough. If `el()` ever started parsing strings as HTML,
   * every one of these call sites would become an injection point at once.
   */
  const dom = fs.readFileSync(path.join(here, '..', 'public/shop/js/core/dom.js'), 'utf8');
  assert.match(dom, /createTextNode/, 'el() no longer appends children as text');
});

/* ════════════════ the default that made him ask "where are the statistics?" ══ */

test('a shop with a real catalogue gets the figures without being told to', async (t) => {
  /*
   * 028 defaulted the band to off. The reasoning was about the platform — a
   * band announcing a product count reads as an apology at 11 — and it was
   * wrong about the person who ASKED for the band: he published the release
   * containing it and the feature was invisible.
   *
   * 029 derives the value instead: a shop with something to say gets it, a
   * nearly-empty shop does not, and neither has to know the setting exists.
   * Both directions are tested, plus the case that matters on a second run —
   * a shop that has already chosen keeps its choice.
   */
  const { openConnection } = await import('../src/infrastructure/database/connection.js');
  const migration = (await import('../src/infrastructure/database/migrations/029-stats-on-for-real-catalogues.js')).default;
  const bigShop = path.join(here, '..', 'data', 'stats-default-test');
  fs.rmSync(bigShop, { recursive: true, force: true });
  fs.mkdirSync(bigShop, { recursive: true });
  t.after(() => fs.rmSync(bigShop, { recursive: true, force: true }));

  /** A shop with `products` published products spread over `brands` brands. */
  const shopWith = async (name, products, brands, stored = '0') => {
    const connection = await openConnection({ driver: 'node', file: path.join(bigShop, `${name}.db`) });
    await connection.applySchema();
    const db = connection.facade;
    await db.prepare(`
      INSERT INTO settings (key, value, value_type, group_name)
      VALUES ('web.stats_enabled', ?, 'string', 'website')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(stored);
    for (let i = 0; i < brands; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await db.prepare('INSERT INTO brands (code, name_en, name_ar) VALUES (?, ?, ?)')
        .run(`B${i}`, `Brand ${i}`, `ماركة ${i}`);
    }
    for (let i = 0; i < products; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await db.prepare(`
        INSERT INTO products (sku_prefix, name_en, brand_id, is_active, is_published)
        VALUES (?, ?, ?, 1, 1)
      `).run(`P-${name}-${i}`, `Product ${i}`, brands ? (i % brands) + 1 : null);
    }
    return { connection, db };
  };
  const valueAfter = async (shop) => {
    await migration.up({ getDb: () => shop.db, hasTable: async () => true });
    const row = await shop.db.prepare("SELECT value FROM settings WHERE key = 'web.stats_enabled'").get();
    shop.connection.close();
    return row?.value;
  };

  await t.test('a shop with a catalogue gets the band', async () => {
    assert.equal(await valueAfter(await shopWith('big', 40, 5)), '1');
  });

  await t.test('a shop with almost nothing on the shelves does not', async () => {
    // "11 PRODUCTS · 2 BRANDS" is not confidence, it is an apology.
    assert.equal(await valueAfter(await shopWith('small', 11, 2)), '0');
  });

  await t.test('a big shop that stocks one brand does not get a "1 BRANDS" cell', async () => {
    assert.equal(await valueAfter(await shopWith('onebrand', 200, 1)), '0');
  });

  await t.test('a shop that already switched it on is left alone', async () => {
    assert.equal(await valueAfter(await shopWith('already', 40, 5, '1')), '1');
  });

  await t.test('a shop that switched it OFF deliberately keeps it off', async () => {
    /*
     * The one that stops this being an overrule. A value of '0' is the only
     * thing this migration touches — but it has already run by the time
     * anybody could have chosen '0' themselves, and a migration that has run
     * never runs again. The check here is on the OTHER shape: anything that is
     * not exactly '0' is untouched, so a shop storing 'false' or 'no' is safe.
     */
    assert.equal(await valueAfter(await shopWith('explicit', 40, 5, 'false')), 'false');
  });
});
