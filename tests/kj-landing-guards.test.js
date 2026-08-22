/**
 * The three gates on the landing page's own document — `public/kj/guards.js`.
 *
 * Everything the owner types in KJ Admin is rendered as text, with one set of
 * exceptions: an image `src`, a phone number that becomes `tel:` and `wa.me`,
 * and an address that becomes `mailto:`. Those four attributes are the only
 * places where a string he typed stops being content, so they are the only
 * strings that get a gate.
 *
 * This file exists because of a bug that made no noise at all. `safeAsset`
 * matched the whole URL against one anchored regex, and the only asset URL the
 * server ever mints carries a `?v=<hash>` cache key — so the real URL failed
 * the real check, every time. The owner uploaded his logo, the console showed
 * it back to him, `/api/landing` served it, and the page kept wearing its
 * monogram. Nothing threw. Nothing was logged. The feature simply did not
 * work, and it took a screenshot from the owner to find it.
 *
 * So the first thing asserted below is the exact URL shape the server mints,
 * spelled out rather than described — if the two halves ever disagree again,
 * they disagree here first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { intlPhone, safeEmail, safeAsset } = await import('../public/kj/guards.js');

test('the landing page decides what it will load and dial', async (ctx) => {
  await ctx.test('the URL the server actually mints survives intact', () => {
    // src/platform/LandingContentService.js mints exactly this: the asset
    // route, plus a `v` cache key. Written out, not built from a pattern —
    // a test that constructs the URL the same way the code does would have
    // passed while the bug was live.
    assert.equal(
      safeAsset('/api/landing/asset/logo?v=645f3083ea'),
      '/api/landing/asset/logo?v=645f3083ea',
    );
    assert.equal(
      safeAsset('/api/landing/asset/hero?v=0a1b2c3d4e'),
      '/api/landing/asset/hero?v=0a1b2c3d4e',
    );
    assert.equal(
      safeAsset('/api/landing/asset/shot-pos?v=deadbeef'),
      '/api/landing/asset/shot-pos?v=deadbeef',
    );
  });

  await ctx.test('the built-ins in this repo are loadable too', () => {
    assert.equal(safeAsset('/kj/shots/pos-ar.webp'), '/kj/shots/pos-ar.webp');
    assert.equal(safeAsset('/api/landing/asset/logo'), '/api/landing/asset/logo');
  });

  await ctx.test('nothing off this deployment is loadable', () => {
    for (const hostile of [
      'https://evil.example/x.png',
      'http://evil.example/x.png',
      '//evil.example/x.png',
      'javascript:alert(1)',
      'data:image/svg+xml,<svg onload=alert(1)>',
      '/etc/passwd',
      '/api/landing/asset/../../secret',
      '/kj/../../src/server.js',
      '   ',
      null,
      undefined,
      42,
      {},
    ]) {
      assert.equal(safeAsset(hostile), '', `${String(hostile)} must not be loadable`);
    }
  });

  await ctx.test('a relative path is resolved against the root, not the page', () => {
    // `/kj` and `/kj/` are the same page but not the same base, so a relative
    // path in the document would mean two different files depending on which
    // address the visitor arrived at. It is resolved against the root here and
    // handed back absolute — the same picture whichever link was shared.
    assert.equal(safeAsset('api/landing/asset/logo'), '/api/landing/asset/logo');
    assert.equal(safeAsset('kj/shots/pos-ar.webp'), '/kj/shots/pos-ar.webp');
    // Resolution happens BEFORE the check, so traversal cannot climb out.
    assert.equal(safeAsset('/api/landing/asset/../../secret'), '');
    assert.equal(safeAsset('/kj/../../src/server.js'), '');
  });

  await ctx.test('a query is allowed to carry a cache key and nothing else', () => {
    // The point is not to refuse the URL over a parameter it did not expect —
    // that is the failure this whole file is named after. Drop the extra and
    // keep the picture.
    assert.equal(safeAsset('/api/landing/asset/logo?v=abc&onerror=1'), '/api/landing/asset/logo?v=abc');
    assert.equal(safeAsset('/api/landing/asset/logo?onerror=1'), '/api/landing/asset/logo');
    assert.equal(safeAsset('/api/landing/asset/logo?v=<script>'), '/api/landing/asset/logo');
    assert.equal(safeAsset('/api/landing/asset/logo?v='), '/api/landing/asset/logo');
    // A fragment cannot smuggle anything past an <img> either.
    assert.equal(safeAsset('/api/landing/asset/logo?v=abc#x'), '/api/landing/asset/logo?v=abc');
  });

  await ctx.test('an Egyptian number reaches WhatsApp in the shape wa.me wants', () => {
    assert.equal(intlPhone('01552526142'), '201552526142');
    assert.equal(intlPhone('01121249801'), '201121249801');
    assert.equal(intlPhone('+20 115 212 4980'), '201152124980');
    assert.equal(intlPhone('20 1552526142'), '201552526142');
    // Already international, already clean.
    assert.equal(intlPhone('201552526142'), '201552526142');
    assert.equal(intlPhone(''), '');
    assert.equal(intlPhone('not a number'), '');
    assert.equal(intlPhone(null), '');
  });

  await ctx.test('an address is an address', () => {
    assert.equal(safeEmail('kerolosnashatestfanous@gmail.com'), 'kerolosnashatestfanous@gmail.com');
    for (const bad of [
      'no-at-sign',
      'a@b',
      'a b@c.com',
      'a@c.com\nBcc: someone@else.com',
      '"><script>@x.com',
      '',
      null,
    ]) {
      assert.equal(safeEmail(bad), '', `${String(bad)} is not an address`);
    }
  });
});
