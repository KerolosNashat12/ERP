/**
 * Proving ownership of an address — `src/shared/siteVerification.js`.
 *
 * The failure this fences is one the owner hit before the mechanism existed,
 * and its shape is the point. Google fetched
 * `…/t/mm/googled257427171a03a47.html`, the `/t/:slug*` catch-all answered
 * `200` with a shop's HTML, and Search Console reported:
 *
 *     Your verification file has the wrong content.
 *
 * Not "missing" — WRONG, because something came back. A catch-all turns every
 * absent file into a present, incorrect one, and the reader is then told they
 * uploaded the wrong thing when they uploaded nothing at all. This project has
 * paid for that lesson twice now; the tests below are the receipt.
 *
 * What is asserted:
 *  - the content is EXACTLY what the search engine issued (it is compared byte
 *    for byte on their side, so a stray newline is a failed verification);
 *  - `robots.txt` allows every file by name, at the root and under a tenant
 *    prefix, because `Disallow: /` is this host's default and a crawler that
 *    will not fetch the file cannot verify the site;
 *  - and nothing else was opened up in the process.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VERIFICATION_FILES, verificationNames, verificationPaths,
} from '../src/shared/siteVerification.js';
import { robotsTxt } from '../src/services/SitemapService.js';

test('a search engine can prove who owns this address', async (ctx) => {
  await ctx.test('every file is named and shaped the way its issuer asks', () => {
    assert.ok(verificationNames().length > 0, 'no verification file is registered');
    for (const [name, body] of Object.entries(VERIFICATION_FILES)) {
      assert.match(name, /^[A-Za-z0-9._-]+$/, `${name} is not a plain filename`);
      assert.ok(!name.includes('/'), `${name} must not contain a path`);
      assert.equal(typeof body, 'string');
      assert.ok(body.length > 0, `${name} is empty`);
      /**
       * Google compares the body exactly. Whitespace at either end is the
       * classic way this fails while looking correct in an editor.
       */
      assert.equal(body, body.trim(), `${name} has leading or trailing whitespace`);
      if (name.startsWith('google')) {
        assert.equal(
          body, `google-site-verification: ${name}`,
          `${name} does not contain the exact line Google issues`,
        );
      }
    }
  });

  await ctx.test('robots.txt allows each one, at the root and under a shop', () => {
    const robots = robotsTxt({ sitemapUrl: 'https://example.test/sitemap.xml', prefixes: ['', '/t/*'] });
    for (const name of verificationNames()) {
      assert.ok(robots.includes(`Allow: /${name}`), `robots.txt does not allow /${name}`);
      assert.ok(robots.includes(`Allow: /t/*/${name}`), `robots.txt does not allow /t/*/${name}`);
    }
    // The refusal it sits inside is still the default, or allowing the file
    // would be meaningless and everything else would be exposed with it.
    assert.ok(robots.includes('Disallow: /\n'), 'robots.txt no longer refuses by default');
  });

  await ctx.test('allowing them opened nothing else', () => {
    const before = robotsTxt({ prefixes: [''] })
      .split('\n').filter((l) => l.startsWith('Allow:'));
    const names = new Set(verificationNames().map((n) => `Allow: /${n}`));
    const extra = before.filter((l) => !names.has(l));
    // Whatever else is allowed must be a shop, an image, the shared modules or
    // the marketing page — never a bare path somebody added by accident.
    for (const line of extra) {
      assert.match(
        line,
        /^Allow: (\/shop|\/api\/shop\/(images\/|logo|banner)|\/shared\/|\/kj)$/,
        `robots.txt allows something unexpected: ${line}`,
      );
    }
  });

  await ctx.test('paths are built for every prefix it is given', () => {
    assert.deepEqual(verificationPaths([]), []);
    const one = verificationPaths(['']);
    const two = verificationPaths(['', '/t/*']);
    assert.equal(two.length, one.length * 2);
    for (const p of two) assert.ok(p.startsWith('/'), `${p} is not absolute`);
  });
});
