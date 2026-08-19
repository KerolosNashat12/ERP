/**
 * Every shop wears its own brand.
 *
 * The bug this is about: the platform hosts more than one shop, and the second
 * one sells clothes. Its website showed the first shop's monogram, the first
 * shop's wording and the first shop's gold, because those were string literals
 * in the storefront. A shop's identity has to be something it owns in its own
 * database — so the proof has to be two shops in ONE process, each reading the
 * other's requests' answers back, with nothing of one appearing in the other.
 *
 * Two shops, deliberately unequal:
 *   - `banat`  — a clothes shop that has configured everything: a logo, a pink
 *                accent, a light theme, its own words;
 *   - `kanz`   — provisioned five minutes ago and configured with nothing,
 *                which must still get a complete, renderable identity.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'data', 'shop-branding-test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

process.env.MM_PLATFORM = '1';
process.env.MM_PLATFORM_DB = path.join(dir, 'platform.db');
process.env.MM_TENANTS_DIR = path.join(dir, 'tenants');
process.env.MM_DB_FILE = path.join(dir, 'root.db');

const { createApp } = await import('../src/server.js');
const {
  initDb, applySchema, closeDb, openConnection, runWithTenant, getDb,
} = await import('../src/infrastructure/database/connection.js');
const { connectionFor } = await import('../src/infrastructure/database/connections.js');
const { initPlatformDb, closePlatformDb, platformDb } = await import('../src/platform/db.js');
const tenantService = (await import('../src/platform/TenantService.js')).default;
const { monogram, normalizeHexColor } = await import('../src/shared/branding.js');

let base = '';
let server = null;
const shops = {};

// ------------------------------------------------------------------ helpers

/**
 * A real PNG, built here rather than pasted as a blob, so the bytes are known
 * exactly and the two shops' logos are provably different pictures.
 *
 * It carries an alpha channel on purpose: a logo sits on a dark header and a
 * light strip alike, and the one thing that must survive the round trip
 * unaltered is the transparency. Nothing on the server re-encodes it — this
 * test is what proves that, by comparing bytes.
 */
function png(width, height, [r, g, b, a]) {
  const chunk = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, 'latin1'), body])), 0);
    return Buffer.concat([head, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type 6 = RGBA — the alpha channel a logo needs
  const raw = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([
    Buffer.from([0]), // filter: none
    ...Array.from({ length: width }, () => Buffer.from([r, g, b, a])),
  ])));

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dataUrl = (bytes, declared = 'image/png') => `data:${declared};base64,${bytes.toString('base64')}`;

async function api(urlPath, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, cookie: setCookie ? setCookie.split(';')[0] : cookie };
}

async function ok(urlPath, options = {}) {
  const res = await api(urlPath, options);
  assert.ok(res.status >= 200 && res.status < 300,
    `${options.method || 'GET'} ${urlPath} -> ${res.status} ${JSON.stringify(res.data)}`);
  return res.data;
}

/** A provisioned shop. Signing in needs a listening server, so it happens after. */
async function shop(slug, nameEn, nameAr) {
  const provisioned = await tenantService.create({
    slug, nameEn, nameAr, modules: ['dashboard', 'products', 'sales', 'settings'], websiteEnabled: true,
  });
  return {
    slug, nameEn, nameAr, username: provisioned.adminUsername, password: provisioned.adminPassword,
  };
}

/**
 * A statement run straight against one shop's own database, through the
 * connection the app itself is using. This is how a value the ERP would never
 * accept gets into a row: a hand edit, a restored backup, an import written by
 * an older build. The read path has to survive it.
 */
async function inShopDb(slug, fn) {
  const row = await platformDb().prepare('SELECT driver, db_file, db_url, db_auth_token FROM tenants WHERE slug = ?').get(slug);
  const connection = await connectionFor(slug, () => openConnection({
    driver: row.driver || 'sqlite', file: row.db_file, url: row.db_url, authToken: row.db_auth_token,
  }));
  return runWithTenant({ slug }, connection, () => fn(getDb()));
}

const config = (slug) => ok(`/t/${slug}/api/shop/config`);

before(async () => {
  await initDb();
  await applySchema();
  await initPlatformDb();

  // The clothes shop. Its Arabic name is the one from the brief: "حب البنات",
  // whose monogram is "ح ب" — the second letter comes from البنات with the
  // definite article stripped, which is the whole reason this is derived
  // server-side rather than in two storefront languages.
  shops.banat = await shop('banat', 'Banat Boutique', 'حب البنات');
  // The new shop: nothing configured, ever.
  shops.kanz = await shop('kanz', 'Kanz Store', 'كنز');

  const app = createApp();
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  // Each shop's own admin, signed into its own ERP: no session crosses a shop
  // boundary here any more than a logo does.
  for (const entry of Object.values(shops)) {
    const login = await api(`/t/${entry.slug}/api/auth/login`, {
      method: 'POST',
      body: { username: entry.username, password: entry.password },
    });
    assert.equal(login.status, 200, `${entry.slug} admin signs in`);
    entry.cookie = login.cookie;
  }
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await closeDb();
  await closePlatformDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------- the derivation rule

test('a monogram is the first letters of the first two words — in the script the name is written in', () => {
  // Arabic: the letters must not be written adjacent (they would fuse into one
  // joined form), and the definite article ال carries no identity — so البنات
  // gives ب, not ا.
  assert.equal(monogram('حب البنات'), 'ح ب');
  assert.equal(monogram('المتجر الكبير'), 'م ك');

  // Latin: uppercased, no separator, and punctuation inside a word is ignored
  // rather than counted as a letter.
  assert.equal(monogram('M&M Accessories'), 'MA');
  assert.equal(monogram('kanz store'), 'KS');

  // One word gives two letters: a single letter reads as an accident.
  assert.equal(monogram('Zara'), 'ZA');
  assert.equal(monogram('كنز'), 'ك ن');

  // Nothing letter-like is null, not an empty box the caller cannot detect.
  assert.equal(monogram('   '), null);
  assert.equal(monogram(null), null);
});

test('a hex colour is normalised, and anything that is not one is refused', () => {
  assert.equal(normalizeHexColor('#C8A24A'), '#c8a24a');
  assert.equal(normalizeHexColor('c8a24a'), '#c8a24a');
  assert.equal(normalizeHexColor('#abc'), '#aabbcc');
  for (const bad of ['', 'red', '#12345', '#ggghhh', 'javascript:alert(1)', null]) {
    assert.equal(normalizeHexColor(bad), null, JSON.stringify(bad));
  }
});

// ------------------------------------------- a shop that has configured nothing

test('a brand-new shop still gets a complete, renderable identity', async () => {
  const { branding } = await config('kanz');

  assert.equal(branding.logo, null, 'no logo has been uploaded');
  // ...and something to draw in its place, in both languages, derived from
  // this shop's own name.
  assert.equal(branding.monogram.en, 'KS');
  assert.equal(branding.monogram.ar, 'ك ن');

  // Every string the page needs is resolved server-side: the client has no
  // fallback of its own to get wrong in one language and right in the other.
  assert.equal(branding.searchPlaceholder.en, 'Search products…');
  assert.ok(branding.searchPlaceholder.ar.length > 0);
  assert.equal(branding.about.en, 'Kanz Store');
  assert.equal(branding.about.ar, 'كنز');
  assert.equal(branding.metaDescription.en, 'Kanz Store');
  assert.equal(branding.metaDescription.ar, 'كنز');
  assert.equal(branding.accent, '#c8a24a', 'the documented default palette');
  assert.equal(branding.dark, true);

  // A tagline is the one thing not invented: an unearned line beside the name
  // is a claim the shop never made. Both keys are still present and typed.
  assert.deepEqual(branding.tagline, { en: null, ar: null });
});

test('nothing a shop was never told about names a product category', async () => {
  const payload = JSON.stringify(await config('kanz'));
  for (const leak of [/bags?/i, /perfume/i, /jewellery/i, /accessor/i, /M&M/]) {
    assert.doesNotMatch(payload, leak, `a new shop's website must not mention ${leak}`);
  }
});

// ------------------------------------------------------------------- the logo

test('an uploaded logo comes back byte for byte, as the PNG it was sent as', async () => {
  const bytes = png(16, 16, [0xff, 0x5a, 0xa2, 0x80]); // half-transparent pink
  const meta = await ok('/t/banat/api/settings/website/logo', {
    method: 'PUT', cookie: shops.banat.cookie, body: { dataUrl: dataUrl(bytes) },
  });
  assert.equal(meta.hasImage, true);
  assert.equal(meta.contentType, 'image/png', 'a logo has transparency and must stay a PNG');
  assert.deepEqual([meta.width, meta.height], [16, 16]);

  const res = await fetch(`${base}/t/banat/api/shop/logo`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.match(res.headers.get('cache-control') || '', /max-age=300/);
  assert.doesNotMatch(res.headers.get('cache-control') || '', /immutable/,
    'one URL that outlives its bytes may never be immutable');

  const served = Buffer.from(await res.arrayBuffer());
  assert.ok(served.equals(bytes), 'the exact bytes, alpha channel and all');

  // And the config points at it, so the storefront never has to probe.
  assert.equal((await config('banat')).branding.logo, '/api/shop/logo');
});

test('one shop\'s logo is not served to another shop, in the same process', async () => {
  // `kanz` has never uploaded one. The two shops answer on the same server,
  // one request apart, out of two different databases.
  const missing = await fetch(`${base}/t/kanz/api/shop/logo`);
  assert.equal(missing.status, 404);
  assert.equal((await config('kanz')).branding.logo, null,
    'and its config says so, rather than pointing at a URL that 404s');

  // The other direction, to prove the first answer was not a cache miss: both
  // shops upload, and each gets its own picture back.
  const kanzBytes = png(8, 8, [0x00, 0x00, 0xff, 0xff]);
  await ok('/t/kanz/api/settings/website/logo', {
    method: 'PUT', cookie: shops.kanz.cookie, body: { dataUrl: dataUrl(kanzBytes) },
  });

  const [fromBanat, fromKanz] = await Promise.all([
    fetch(`${base}/t/banat/api/shop/logo`).then((r) => r.arrayBuffer()).then(Buffer.from),
    fetch(`${base}/t/kanz/api/shop/logo`).then((r) => r.arrayBuffer()).then(Buffer.from),
  ]);
  assert.ok(fromKanz.equals(kanzBytes));
  assert.ok(!fromBanat.equals(fromKanz), 'two shops, two logos, no crossover');

  // Put `kanz` back to the unconfigured shop the rest of this file describes.
  await ok('/t/kanz/api/settings/website/logo', { method: 'DELETE', cookie: shops.kanz.cookie });
  assert.equal((await fetch(`${base}/t/kanz/api/shop/logo`)).status, 404);
  assert.equal((await config('kanz')).branding.logo, null);
});

test('the content type is taken from the bytes, never from what the upload claimed', async () => {
  // A browser that mislabels its own canvas export — or anything else that
  // lies — must not put `image/jpeg` on a PNG in a public response header.
  const bytes = png(4, 4, [0x11, 0x22, 0x33, 0x44]);
  const meta = await ok('/t/kanz/api/settings/website/logo', {
    method: 'PUT', cookie: shops.kanz.cookie, body: { dataUrl: dataUrl(bytes, 'image/jpeg') },
  });
  assert.equal(meta.contentType, 'image/png');

  const res = await fetch(`${base}/t/kanz/api/shop/logo`);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(bytes), 'and not one byte was re-encoded');

  await ok('/t/kanz/api/settings/website/logo', { method: 'DELETE', cookie: shops.kanz.cookie });
});

test('an upload that is not an image at all is refused', async () => {
  const res = await api('/t/kanz/api/settings/website/logo', {
    method: 'PUT', cookie: shops.kanz.cookie, body: { dataUrl: 'data:image/png;base64,bm90IGFuIGltYWdl' },
  });
  assert.equal(res.status, 422);
  assert.equal((await fetch(`${base}/t/kanz/api/shop/logo`)).status, 404, 'and nothing was stored');
});

// ------------------------------------------------------------------- the words

test('a shop\'s own words reach its own storefront and no other', async () => {
  await ok('/t/banat/api/settings', {
    method: 'PUT',
    cookie: shops.banat.cookie,
    body: {
      'web.tagline_en': 'Dresses, every day',
      'web.tagline_ar': 'فساتين كل يوم',
      'web.about_en': 'A clothes shop in Cairo.',
      'web.about_ar': 'محل ملابس في القاهرة.',
      'web.search_placeholder_en': 'Search dresses…',
      'web.search_placeholder_ar': 'ابحث عن الفساتين…',
      'web.meta_description_en': 'Banat Boutique — clothes for every day.',
      'web.meta_description_ar': 'حب البنات — ملابس لكل يوم.',
    },
  });

  const banat = await config('banat');
  assert.equal(banat.branding.tagline.en, 'Dresses, every day');
  assert.equal(banat.branding.searchPlaceholder.ar, 'ابحث عن الفساتين…');
  assert.equal(banat.branding.about.en, 'A clothes shop in Cairo.');
  assert.equal(banat.branding.metaDescription.ar, 'حب البنات — ملابس لكل يوم.');
  assert.equal(banat.branding.monogram.ar, 'ح ب', 'derived from this shop\'s own name');

  const kanz = JSON.stringify(await config('kanz'));
  for (const leak of ['Dresses', 'فساتين', 'Banat', 'حب البنات', 'A clothes shop in Cairo.']) {
    assert.ok(!kanz.includes(leak), `the new shop's website must not carry "${leak}"`);
  }
  // And its own neutral copy is still what it gets.
  assert.equal((await config('kanz')).branding.searchPlaceholder.en, 'Search products…');
});

// ------------------------------------------------------------------ the colour

test('an accent colour is stored normalised, and a broken one never reaches the page', async () => {
  const saved = await ok('/t/banat/api/settings', {
    method: 'PUT',
    cookie: shops.banat.cookie,
    body: { 'web.theme_accent': '#FF5AA2', 'web.theme_dark': '0' },
  });
  assert.equal(saved['web.theme_accent'], '#ff5aa2', 'one colour, one spelling');

  const banat = await config('banat');
  assert.equal(banat.branding.accent, '#ff5aa2');
  assert.equal(banat.branding.dark, false, "'0' is a non-empty string — it must still mean false");

  // The ERP refuses a value that would blank the palette, while somebody is
  // looking at the screen that produced it.
  for (const bad of ['not-a-colour', '#12345', 'rgb(255,0,0)']) {
    const rejected = await api('/t/banat/api/settings', {
      method: 'PUT', cookie: shops.banat.cookie, body: { 'web.theme_accent': bad },
    });
    assert.equal(rejected.status, 422, `${bad} is refused`);
  }
  assert.equal((await config('banat')).branding.accent, '#ff5aa2', 'and nothing was overwritten');
});

test('a hand-edited row falls back to the default rather than painting a broken page', async () => {
  // Not something the ERP could produce — a hand edit, an import, a restored
  // backup from an older build. It still ends up on `<html>` as a custom
  // property unless the read path refuses it too.
  await inShopDb('kanz', (db) => db
    .prepare("UPDATE settings SET value = 'chartreuse-ish' WHERE key = 'web.theme_accent'").run());

  const { branding } = await config('kanz');
  assert.equal(branding.accent, '#c8a24a', 'the documented default, not the broken value');
  assert.doesNotMatch(JSON.stringify(branding), /chartreuse/i, 'which never reaches the browser');

  await inShopDb('kanz', (db) => db
    .prepare("UPDATE settings SET value = '' WHERE key = 'web.theme_accent'").run());
  assert.equal((await config('kanz')).branding.accent, '#c8a24a', 'and so does an empty one');
});

// ------------------------------------------------------------------- the ERP

test('the ERP shell is told which shop its staff work for', async () => {
  // The sidebar drew M&M for every tenant because the letters were in the
  // markup. `/api/session` is unauthenticated and answers before the shell
  // knows whether anyone is signed in, so the identity travels with it.
  const banat = await ok('/t/banat/api/session');
  assert.equal(banat.tenant.slug, 'banat');
  assert.equal(banat.branding.monogram.ar, 'ح ب');
  assert.equal(banat.branding.logo, '/api/shop/logo');
  assert.equal(banat.branding.accent, '#ff5aa2');

  const kanz = await ok('/t/kanz/api/session');
  assert.equal(kanz.branding.monogram.en, 'KS');
  assert.equal(kanz.branding.logo, null);
  assert.doesNotMatch(JSON.stringify(kanz.branding), /Banat|حب البنات|ff5aa2/,
    'and it is this shop\'s identity, not the one next door');
});

test('renaming a shop in the console renames it inside the shop', async () => {
  // "I changed the store name and nothing changed": the tenant row is only a
  // label in the fleet list. What a customer sees is `company.name` in the
  // shop's own database, and the rename has to reach it.
  const renamed = 'Dalaa El Banat';
  const renamedAr = 'دلع البنات';
  await tenantService.update('banat', { nameEn: renamed, nameAr: renamedAr });

  const config = await (await fetch(`${base}/t/banat/api/shop/config`)).json();
  assert.equal(config.companyName.en, renamed, 'the storefront wears the new name');
  assert.equal(config.companyName.ar, renamedAr);

  const listed = await tenantService.get('banat');
  assert.equal(listed.nameEn, renamed, 'and so does the fleet list');
});
