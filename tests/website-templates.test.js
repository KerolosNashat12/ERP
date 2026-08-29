/**
 * TWO STOREFRONTS, ONE SHOP'S DATA.
 *
 * The owner's ask, in his words: «add the two website templates to the ERP and
 * let admin based on his store business choose the suitable template… But
 * consider all test cases and all inputs that will reflect at each template».
 *
 * That second sentence is the whole design constraint and it is what most of
 * this file is about. A template is a SKIN. Everything a shop configures — its
 * banner, its announcement, its logo, its colour, its tagline, its delivery
 * promise, its categories, its products — has to come out identical under both,
 * because the shop did not change; only its clothes did. A template that
 * quietly dropped an input would be a shop that lost a feature by choosing a
 * design, and it would be found by a customer rather than by a test.
 *
 * So the fence is: render the SAME shop under BOTH templates and assert that
 * every configured value survives both, and that the only difference is the
 * one that is supposed to be there.
 */
import './single-shop.js'; // must be first — see that file
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'data', 'templates-test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
process.env.MM_DB_FILE = path.join(dir, 'shop.db');

const { createApp } = await import('../src/server.js');
const {
  initDb, closeDb, getDb, applySchema,
} = await import('../src/infrastructure/database/connection.js');
const { seedBaseline } = await import('../src/infrastructure/database/seed.js');
const { runMigrations } = await import('../src/infrastructure/database/migrations/index.js');
const branding = await import('../src/shared/branding.js');
const { palette } = await import('../public/shared/brandTheme.js');

let base = '';
let server = null;
let cookie = '';

async function call(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
      'Idempotency-Key': `tpl-${Math.random().toString(36).slice(2)}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, text };
}
const ok = async (p, o) => {
  const res = await call(p, o);
  assert.ok(res.status < 400, `${p} → ${res.status} ${JSON.stringify(res.data).slice(0, 300)}`);
  return res.data;
};

/** Set the template the way the ERP does, and read the shop back. */
const setTemplate = (value) => ok('/api/settings', { method: 'PUT', body: { 'web.template': value } });

/* ══════════════════════════ 1. the value itself, before any shop exists ════ */

test('a template value is validated on the way OUT as well as in', () => {
  /*
   * The read path matters as much as the write. A hand-edited row, a restored
   * backup or an import can put anything in that column, and what must never
   * happen is an unknown template reaching `<html>` — the page would have no
   * design at all rather than the wrong one.
   */
  assert.equal(branding.normalizeTemplate('classic'), 'classic');
  assert.equal(branding.normalizeTemplate('luxe'), 'luxe');
  assert.equal(branding.normalizeTemplate('LUXE'), 'luxe', 'case is not a shop preference');
  assert.equal(branding.normalizeTemplate('  luxe  '), 'luxe');

  for (const junk of ['', null, undefined, 'dark', 'boutique', 'v2', 0, 1, {}, [], '<script>']) {
    assert.equal(branding.normalizeTemplate(junk), 'classic',
      `${JSON.stringify(junk)} became a template`);
  }
});

test('the default is the plain one, and that is deliberate', () => {
  // A platform does not redesign its customers' shops. A shop that has never
  // opened the setting gets what it has always had.
  assert.equal(branding.DEFAULT_TEMPLATE, 'classic');
  assert.deepEqual(branding.TEMPLATES, ['classic', 'luxe']);

  const resolved = branding.buildBranding({
    get: () => null,
    companyName: { en: 'Shop', ar: 'محل' },
  });
  assert.equal(resolved.template, 'classic');
});

test('the two templates are genuinely two designs, not one tinted twice', () => {
  /*
   * The control for everything below. If `night` did nothing, every "the
   * inputs survive both templates" assertion in this file would pass while the
   * feature did not exist.
   */
  const day = palette('#c8a24a', true, { night: false });
  const night = palette('#c8a24a', true, { night: true });
  assert.equal(day.surface, '#ffffff');
  assert.notEqual(night.surface, '#ffffff');
  assert.ok(Number.parseInt(night.bg.slice(1, 3), 16) < 20, 'the boutique page is not dark');
  assert.ok(Number.parseInt(day.bg.slice(1, 3), 16) > 200, 'the classic page is not light');
  // And the shop's colour is the shop's colour in both.
  assert.equal(day.accentRaw, night.accentRaw);
});

/* ═════════════════════════════════ 2. a real shop, wearing each in turn ════ */

test('a shop keeps every one of its settings under both templates', async (t) => {
  await initDb();
  await applySchema();
  await seedBaseline();
  await runMigrations();

  server = await new Promise((resolve) => {
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
  }).then((res) => res.headers.get('set-cookie'))).split(';')[0];

  /*
   * EVERY WEBSITE INPUT A SHOP CAN SET, filled with a value that could only
   * have come from this test. Anything that fails to appear under one template
   * is a feature that shop lost by choosing a design.
   */
  const INPUTS = {
    'web.tagline_en': 'Tagline EN marker',
    'web.tagline_ar': 'شعار عربي علامة',
    'web.about_en': 'About EN marker',
    'web.about_ar': 'من إحنا علامة',
    'web.search_placeholder_en': 'Search marker EN',
    'web.search_placeholder_ar': 'ابحث علامة',
    'web.meta_description_en': 'Meta EN marker',
    'web.meta_description_ar': 'وصف عربي علامة',
    'shop.announcement_en': 'Announcement EN marker',
    'shop.announcement_ar': 'إعلان عربي علامة',
    'web.banner_heading_en': 'Banner heading marker',
    'web.banner_heading_ar': 'عنوان بانر علامة',
    'web.banner_text_en': 'Banner body marker',
    'web.banner_text_ar': 'نص بانر علامة',
    'web.theme_accent': '#7c3aed',
    'web.banner_align': 'left',
    'web.banner_valign': 'bottom',
    'web.banner_text_size': 'large',
    'web.banner_text_color': 'dark',
    'web.banner_box_width': 65,
    'shop.delivery_mode': 'percent',
    'shop.delivery_percent': 12,
    'shop.delivery_min': 40,
    'shop.free_delivery_over': 1500,
    'shop.whatsapp': '201552526142',
  };
  await ok('/api/settings', { method: 'PUT', body: INPUTS });

  // Something on the shelves, so the catalogue half is real too.
  const brand = await ok('/api/brands', { method: 'POST', body: { name_en: 'Marker Brand', name_ar: 'ماركة علامة' } });
  const category = await ok('/api/categories', { method: 'POST', body: { name_en: 'Marker Category', name_ar: 'فئة علامة' } });
  const product = await ok('/api/products', {
    method: 'POST',
    body: {
      sku_prefix: 'TPL', name_en: 'Marker Product', name_ar: 'منتج علامة',
      base_price: 250, brand_id: brand.id, category_id: category.id, is_published: 1,
      variants: [{ sku: 'TPL-1', variant_label: '', cost_price: 100, selling_price: 250 }],
    },
  });
  await ok('/api/inventory/quick-adjust', {
    method: 'POST', body: { variantId: product.variants[0].id, newQuantity: 9, reason: 'correction' },
  });

  /** Everything the storefront is handed, under whichever template is set. */
  const shopUnder = async (template) => {
    await setTemplate(template);
    const config = await ok('/api/shop/config');
    const home = await ok('/api/shop/home');
    const products = await ok('/api/shop/products?page=1');
    const page = await call('/shop');
    return { config, home, products, page };
  };

  const classic = await shopUnder('classic');
  const luxe = await shopUnder('luxe');

  await t.test('the template is the ONLY thing that differs in the config', () => {
    /*
     * Compared as whole objects with the one expected difference removed. A
     * field-by-field list would pass on a field somebody adds tomorrow and
     * forgets to check.
     */
    const strip = (config) => {
      const copy = JSON.parse(JSON.stringify(config));
      delete copy.branding.template;
      return copy;
    };
    assert.deepEqual(strip(classic.config), strip(luxe.config),
      'a shop is handed different data depending on which design it wears');
    assert.equal(classic.config.branding.template, 'classic');
    assert.equal(luxe.config.branding.template, 'luxe');
  });

  await t.test('every configured word survives both templates', () => {
    const markers = Object.values(INPUTS).filter((v) => typeof v === 'string' && v.includes('marker'))
      .concat(['شعار عربي علامة', 'إعلان عربي علامة', 'عنوان بانر علامة']);
    for (const [label, shop] of [['classic', classic], ['luxe', luxe]]) {
      const blob = JSON.stringify(shop.config);
      const missing = markers.filter((marker) => !blob.includes(marker));
      assert.deepEqual(missing, [],
        `${label} lost these configured values: ${missing.join(', ')}`);
    }
  });

  await t.test('the shop\'s own colour reaches both, unchanged', () => {
    assert.equal(classic.config.branding.accent, '#7c3aed');
    assert.equal(luxe.config.branding.accent, '#7c3aed',
      'the boutique template overrode the shop\'s colour with its own');
  });

  await t.test('the delivery promise is the same money under both', () => {
    assert.deepEqual(classic.config.delivery, luxe.config.delivery);
    assert.equal(luxe.config.delivery.percent, 12);
    assert.equal(luxe.config.delivery.freeOver, 1500);
  });

  await t.test('the catalogue is identical — same products, brands, categories', () => {
    assert.deepEqual(classic.products.rows, luxe.products.rows);
    assert.deepEqual(classic.home.categories, luxe.home.categories);
    assert.deepEqual(classic.home.brands, luxe.home.brands);
    // And it is not empty, or the assertion above proves nothing.
    assert.ok(classic.products.rows.length > 0, 'no products — this comparison is vacuous');
  });

  await t.test('the banner settings a shop configured apply under both', () => {
    assert.deepEqual(classic.config.banner, luxe.config.banner);
    assert.equal(luxe.config.banner.align, 'left');
    assert.equal(luxe.config.banner.boxWidth, 65);
  });

  await t.test('the server-rendered page paints the right paper on the FIRST byte', () => {
    /*
     * Not cosmetic. Without this the browser paints the classic white page and
     * repaints black once the config lands — a flash on every visit, worst on
     * a phone arriving from Google, which is the visit that matters most.
     */
    assert.match(classic.page.text, /<html[^>]+data-paper="day"/,
      'the classic page does not declare its paper');
    assert.match(luxe.page.text, /<html[^>]+data-paper="night"/,
      'the boutique page would flash white before going dark');
  });

  await t.test('the SEO the page carries does not depend on its design', () => {
    const meta = (html) => ({
      title: (html.match(/<title[^>]*>([^<]*)<\/title>/) || [])[1],
      description: (html.match(/<meta name="description" content="([^"]*)"/) || [])[1],
      canonical: (html.match(/<link rel="canonical" href="([^"]*)"/) || [])[1],
      robots: (html.match(/<meta name="robots" content="([^"]*)"/) || [])[1],
    });
    assert.deepEqual(meta(classic.page.text), meta(luxe.page.text),
      'changing the design changed what Google is told about the shop');
    assert.ok(meta(luxe.page.text).title, 'the page has no title at all');
  });

  await t.test('an unknown template is refused at the ERP, where somebody is looking', async () => {
    for (const bad of ['dark', 'v2', 'Luxe!', 'classic ; drop']) {
      const res = await call('/api/settings', { method: 'PUT', body: { 'web.template': bad } });
      assert.ok(res.status >= 400, `"${bad}" was saved as a template`);
    }
    // And the shop is still on the last good value rather than on nothing.
    const after = await ok('/api/shop/config');
    assert.equal(after.branding.template, 'luxe');
  });

  await t.test('switching design changes nothing about the shop\'s data', async () => {
    /*
     * The reassurance the setting's own hint makes to a shop owner: "nothing
     * about your products, prices or orders changes with it". Asserted rather
     * than promised.
     */
    const before = await ok('/api/products?page=1&pageSize=50');
    await setTemplate('classic');
    await setTemplate('luxe');
    await setTemplate('classic');
    const after = await ok('/api/products?page=1&pageSize=50');
    assert.deepEqual(after.rows, before.rows);
  });
});

/* ═══════════════════ 3. the migration: nobody's site changes overnight ════ */

test('an existing shop keeps the design it is already wearing', async (t) => {
  /*
   * The migration derives the value from `web.theme_dark` rather than
   * defaulting, because for one release that switch WAS the night storefront.
   * A shop with it on is looking at the boutique design right now, and writing
   * 'classic' into every row would take that away on an update installed for
   * something else entirely.
   *
   * Both directions are checked, and so is the case that matters most on a
   * second run: a shop that has already chosen keeps its choice.
   */
  const { openConnection } = await import('../src/infrastructure/database/connection.js');
  const cases = [
    { name: 'dark-on', dark: '1', expect: 'luxe' },
    { name: 'dark-off', dark: '0', expect: 'classic' },
    { name: 'never-set', dark: null, expect: 'luxe' },
  ];

  for (const testCase of cases) {
    await t.test(`a shop with theme_dark = ${testCase.dark} gets ${testCase.expect}`, async () => {
      const file = path.join(dir, `${testCase.name}.db`);
      fs.mkdirSync(dir, { recursive: true });
      const connection = await openConnection({ driver: 'node', file });
      await connection.applySchema();
      /*
       * `openConnection()` hands back the connection RECORD — driver, facade,
       * transaction, applySchema — not the `prepare()`-shaped thing every
       * repository writes against. That one is `.facade`, which is exactly what
       * `getDb()` returns, so passing it to the migration below gives the
       * migration the same object it gets in production rather than a
       * test-only stand-in.
       */
      const db = connection.facade;

      // A shop that existed BEFORE this release: it has the old switch and no
      // template row at all.
      if (testCase.dark !== null) {
        await db.prepare(`
          INSERT INTO settings (key, value, value_type, group_name)
          VALUES ('web.theme_dark', ?, 'boolean', 'website')
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(testCase.dark);
      }
      await db.prepare("DELETE FROM settings WHERE key = 'web.template'").run();

      const migration = (await import('../src/infrastructure/database/migrations/026-website-template.js')).default;
      await migration.up({
        getDb: () => db,
        hasTable: async () => true,
      });

      const row = await db.prepare("SELECT value FROM settings WHERE key = 'web.template'").get();
      assert.equal(row?.value, testCase.expect,
        `a shop that was on ${testCase.dark === null ? 'the default' : `theme_dark=${testCase.dark}`} had its site changed`);

      // Run it again — a migration that re-derived on every run would undo a
      // shop owner's later decision the next time anything shipped.
      await db.prepare("UPDATE settings SET value = 'classic' WHERE key = 'web.template'").run();
      await migration.up({ getDb: () => db, hasTable: async () => true });
      const again = await db.prepare("SELECT value FROM settings WHERE key = 'web.template'").get();
      assert.equal(again?.value, 'classic', 'the migration overwrote a choice somebody had made');

      connection.close();
    });
  }
});
