/**
 * A PICTURE'S ADDRESS NEEDS THE TENANT PREFIX TOO.
 *
 * The bug, reported with a screenshot of the brands screen on the live shop:
 * every brand that HAD a logo drew a broken-image icon, while every brand
 * without one drew its letter correctly. His words: «why this bug ???».
 *
 * The cause was one literal. The brands screen built its thumbnail as
 *
 *     src: `/api/brands/${r.id}/logo/raw`
 *
 * which is correct on the single-shop build and WRONG on the multi-tenant
 * one. The ERP is one SPA served at `/` for a shop running it on its own PC
 * and at `/t/<slug>/` for a shop on the hosted platform, and `core/api.js`
 * exists to hide that difference: every `fetch` it makes is prefixed with
 * `apiBase()`. An `<img src>` never goes through that door — the browser
 * issues the request itself — so it is the ONE kind of API call a view can
 * build by hand without anything noticing. Two views had:
 * the brands screen (the chip in the list and the preview in its dialog) and
 * the product photo editor, which meant every product photograph in the
 * catalogue was a torn page for every hosted shop.
 *
 * It fails silently and it fails ONLY when hosted, which is why it survived:
 * on a developer's `localhost:4000` the prefix is empty and the literal is
 * right. Nothing throws, no request the UI can see fails, no test that
 * renders the page notices — the picture is simply not there.
 *
 * This is a SOURCE test because the behaviour needs two deployments to
 * observe. What is fenced is the shape of the mistake: a literal `/api/…`
 * used as the address of something the BROWSER fetches. The addresses are
 * named in `core/api.js` (`brandLogoUrl`, `productImageUrl`,
 * `categoryImageUrl`, and `assetUrl` for anything else) and in the
 * storefront's own `api.js`; a view asks for an address rather than
 * assembling one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRONT_END_FILES as FILES, codeOnly } from './helpers/source.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const rel = (file) => path.relative(path.join(here, '..'), file).split(path.sep).join('/');

/*
 * The address of something the browser fetches on its own: an element's
 * `src`, `href` or `action`, or a CSS `url()`. A path handed to `api.get()`
 * is deliberately NOT matched — that one goes through the door and is
 * prefixed there, and demanding a helper for it would be noise.
 */
const ATTRIBUTE_URL = /\b(?:src|href|action)\s*:\s*[`'"]\/api\//;
const CSS_URL = /url\(\s*[`'"]?\/api\//;

test('the file list is real — the control', () => {
  assert.ok(FILES.length > 20, `only ${FILES.length} front-end files found`);
  assert.ok(FILES.some((f) => f.endsWith('views/masterData.js')), 'masterData.js was not reached');
  assert.ok(FILES.some((f) => f.endsWith('views/catalog.js')), 'catalog.js was not reached');
});

test('no picture address is built by hand', () => {
  const offenders = [];
  for (const file of FILES) {
    const source = codeOnly(fs.readFileSync(file, 'utf8'));
    for (const line of source.split('\n')) {
      if (ATTRIBUTE_URL.test(line) || CSS_URL.test(line)) offenders.push(`${rel(file)} — ${line.trim()}`);
    }
  }
  assert.deepEqual(
    offenders, [],
    'A literal `/api/…` used as an address the browser fetches. It is correct at `/` '
    + 'and 404 at `/t/<slug>/`, so this renders as a broken image on every hosted '
    + 'shop and looks perfect in development. Use a named helper from core/api.js '
    + '(brandLogoUrl, productImageUrl, categoryImageUrl) or assetUrl(path).',
  );
});

test('the helpers actually carry the prefix', async () => {
  /*
   * The check above only proves the views ask a helper. This proves the
   * helper is worth asking: with a tenant path in the address bar, every one
   * of them must answer a URL under `/t/<slug>`. A helper that forgot the
   * prefix would pass the source scan and reproduce the whole bug.
   */
  const seen = [];
  for (const pathname of ['/t/mm/', '/']) {
    global.window = { location: { pathname } };
    const mod = await import(`../public/js/core/api.js?case=${encodeURIComponent(pathname)}`);
    const expected = pathname === '/' ? '' : '/t/mm';
    for (const [name, url] of [
      ['brandLogoUrl', mod.brandLogoUrl(7)],
      ['brandLogoUrl+v', mod.brandLogoUrl(7, '2026-08-30')],
      ['productImageUrl', mod.productImageUrl(3, 9)],
      ['categoryImageUrl', mod.categoryImageUrl(4)],
      ['assetUrl', mod.assetUrl('/api/anything')],
    ]) {
      assert.ok(
        url.startsWith(`${expected}/api/`),
        `${name} answered "${url}" on ${pathname} — it must start with "${expected}/api/"`,
      );
      seen.push(name);
    }
  }
  delete global.window;
  assert.equal(seen.length, 10, 'both deployments were not exercised');
});

test('a replaced logo can be told from the one it replaced', () => {
  /*
   * The address carries no id of its own — `/api/brands/7/logo/raw` is the
   * same string before and after a replacement — so without the version the
   * owner uploads a new mark and keeps seeing the old one. It is a query
   * parameter rather than a path segment because the server serves the slot,
   * not a version of it.
   */
  global.window = { location: { pathname: '/t/mm/' } };
  return import('../public/js/core/api.js?case=version').then((mod) => {
    const bare = mod.brandLogoUrl(7);
    const stamped = mod.brandLogoUrl(7, '2026-08-30 21:14:00');
    assert.ok(!bare.includes('?'), `an unstamped address should be bare, got ${bare}`);
    assert.notEqual(stamped, bare);
    assert.ok(stamped.startsWith(`${bare}?v=`), `expected a v= on ${bare}, got ${stamped}`);
    assert.ok(!stamped.includes(' '), 'the stamp must be encoded — a raw space is not a URL');
    delete global.window;
  });
});
