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
  VERIFICATION_FILES, verificationNames, verificationPaths, contentTypeFor,
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

  await ctx.test('each file is answered as the thing it actually is', () => {
    /**
     * Google's file ends in `.html` and is one line of text; Bing's ends in
     * `.xml` and is parsed as XML. Serving the first as HTML would be the same
     * kind of untruth that made this whole mechanism necessary — a response
     * that claims to be something it is not.
     */
    assert.equal(contentTypeFor('googled257427171a03a47.html'), 'text/plain');
    assert.equal(contentTypeFor('BingSiteAuth.xml'), 'application/xml');
    assert.equal(contentTypeFor('ANYTHING.XML'), 'application/xml');
    for (const name of verificationNames()) {
      assert.match(contentTypeFor(name), /^(text\/plain|application\/xml)$/);
    }
  });

  await ctx.test("Bing's file is well-formed XML holding one user", () => {
    // Bing PARSES this one, so a mangled escape here fails verification in a
    // way the Google file (compared as a string) never could.
    const xml = VERIFICATION_FILES['BingSiteAuth.xml'];
    assert.ok(xml, 'the Bing file is not registered');
    assert.match(xml, /^<\?xml version="1\.0"\?>/);
    const users = [...xml.matchAll(/<user>([^<]+)<\/user>/g)].map((m) => m[1]);
    assert.equal(users.length, 1, 'expected exactly one user token');
    assert.match(users[0], /^[A-F0-9]{32}$/i, 'the Bing token is not a 32-character hex id');
    // Tag balance, cheaply: every opener has a closer.
    for (const tag of ['users', 'user']) {
      assert.equal(
        (xml.match(new RegExp(`<${tag}>`, 'g')) || []).length,
        (xml.match(new RegExp(`</${tag}>`, 'g')) || []).length,
        `<${tag}> is unbalanced`,
      );
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
    // Whatever else is allowed must be a shop, an image, the shared modules,
    // the marketing page or the sitemap — never a bare path somebody added by
    // accident. This list is the point of the test: widening it should take a
    // deliberate edit here, which is what caught the sitemap lines being added.
    for (const line of extra) {
      assert.match(
        line,
        /^Allow: (\/shop|\/api\/shop\/(images\/|logo|banner)|\/shared\/|\/kj|\/sitemap\.xml|\/sitemap\/)$/,
        `robots.txt allows something unexpected: ${line}`,
      );
    }
  });

  await ctx.test('the sitemap it names is a sitemap it allows', () => {
    /**
     * `Sitemap:` names an address. It does not grant permission to fetch it,
     * and `Disallow: /` refuses everything not excepted — so this file could
     * point Google at a map it had just forbidden. The only symptom is Search
     * Console saying the sitemap cannot be read while the URL answers 200 in a
     * browser, which is a very expensive kind of silence.
     */
    const robots = robotsTxt({
      sitemapUrl: 'https://example.test/t/mm/sitemap.xml',
      prefixes: ['', '/t/*'],
    });
    for (const prefix of ['', '/t/*']) {
      assert.ok(robots.includes(`Allow: ${prefix}/sitemap.xml`), `${prefix}/sitemap.xml is not allowed`);
      assert.ok(robots.includes(`Allow: ${prefix}/sitemap/`), `${prefix}/sitemap/ shards are not allowed`);
    }
    // And the named one specifically: whatever address is advertised at the
    // foot of the file must be reachable under the rules above it.
    const named = robots.match(/^Sitemap: (.+)$/m)?.[1];
    assert.ok(named, 'no sitemap is named');
    const path = new URL(named).pathname;
    const allowed = robots.split('\n')
      .filter((l) => l.startsWith('Allow: '))
      .map((l) => l.slice('Allow: '.length));
    assert.ok(
      allowed.some((rule) => new RegExp(`^${rule.replace(/\*/g, '[^/]*')}`).test(path)),
      `the named sitemap ${path} matches no Allow rule`,
    );
  });

  await ctx.test('paths are built for every prefix it is given', () => {
    assert.deepEqual(verificationPaths([]), []);
    const one = verificationPaths(['']);
    const two = verificationPaths(['', '/t/*']);
    assert.equal(two.length, one.length * 2);
    for (const p of two) assert.ok(p.startsWith('/'), `${p} is not absolute`);
  });
});
