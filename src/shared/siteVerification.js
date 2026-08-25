/**
 * The files Google and Bing ask you to put on your own site to prove you own it.
 *
 * ── Why this needed code at all ──────────────────────────────────────────────
 * A verification file is meant to be the simplest thing on the web: drop
 * `googled257…html` in your webroot, the crawler fetches it, it contains one
 * line, you are verified. On a static site that is a file copy. Here it is not,
 * for two reasons that only show up together:
 *
 *   1. The property being verified is `…/t/mm/`, not the root — one shop on a
 *      platform, not the whole host. So the file has to answer under the
 *      tenant prefix, and `public/` served statically only ever answers at `/`.
 *   2. `app.get('/t/:slug*')` is a catch-all that hands back the SPA shell for
 *      any address it does not recognise, which is exactly right for client
 *      routing and exactly wrong here.
 *
 * Together they produce a failure that reads like a mistake you made rather
 * than a file you never uploaded. The owner asked Google to verify before this
 * existed and got back:
 *
 *     Your verification file has the wrong content.
 *     Are you using the verification file that you downloaded here?
 *
 * Not "not found" — WRONG CONTENT, because the catch-all answered `200` with a
 * shop's HTML. The same trap cost a week earlier in this project's life, when a
 * new file answered `200 text/html` and looked like a typo. A missing thing
 * that returns something is worse than a missing thing that returns nothing.
 *
 * ── Why the tokens are committed in plain sight ──────────────────────────────
 * These are NOT secrets, and treating them as secrets is the mistake to avoid.
 * The whole mechanism depends on the token being publicly fetchable by anyone
 * who asks — that is what proves control of the address. It carries no
 * authority: it grants a Search Console account read-only reporting on a site
 * it can already crawl. So it lives in the repository, like the sitemap, and
 * not in an environment variable where it would be one more thing to lose.
 *
 * ── Adding one ───────────────────────────────────────────────────────────────
 * Paste the filename and the single line the search engine gives you. The
 * content must match byte for byte — Google compares it exactly, and a
 * "helpfully" added trailing newline or a smart quote is the difference
 * between verified and the message above.
 */

export const VERIFICATION_FILES = {
  // Google Search Console, property https://erp-rust-one.vercel.app/t/mm/
  // Added 2026-08-24 for M&M Accessories.
  'googled257427171a03a47.html': 'google-site-verification: googled257427171a03a47.html',

  /**
   * Bing Webmaster Tools, site https://erp-rust-one.vercel.app/t/mm/shop
   * Added 2026-08-25.
   *
   * Bing needed its own entry rather than importing the Google one: its
   * "Import from Google Search Console" only understands sites verified at the
   * level of a whole host, and this property is one shop inside one — a path.
   * It reported that as "we didn't find any sites from GSC", which reads like
   * the Google side is broken when nothing about it is.
   */
  'BingSiteAuth.xml': '<?xml version="1.0"?>\n<users>\n\t<user>CD107F304499F62AF81FDC7F3D680E97</user>\n</users>',
};

/**
 * What to answer a verification request with.
 *
 * These files are named `.html` and `.xml` but only one of them is really
 * either: Google's is a single line of text that happens to end in `.html`, and
 * sending it as HTML would be calling it something it is not. Bing's genuinely
 * is XML and is parsed as XML, so it gets the type that says so. Derived from
 * the extension rather than stored per entry, because the registry above should
 * stay exactly what the search engine handed over and nothing else.
 */
export const contentTypeFor = (name) => (
  name.toLowerCase().endsWith('.xml') ? 'application/xml' : 'text/plain'
);

/** The filenames, in the order they were added. */
export const verificationNames = () => Object.keys(VERIFICATION_FILES);

/**
 * Every address a verification file must be reachable at, for `robots.txt`.
 *
 * `Disallow: /` is this host's default and it is deliberate — everything is a
 * back office unless it is a shop. But a crawler that will not fetch the file
 * cannot verify the site, so each one is allowed explicitly, at the root and
 * under every tenant prefix. Allowing them by name rather than by pattern
 * keeps the refusal honest: nothing else becomes fetchable.
 */
export function verificationPaths(prefixes = ['']) {
  const paths = [];
  for (const prefix of prefixes) {
    for (const name of verificationNames()) paths.push(`${prefix}/${name}`);
  }
  return paths;
}

export default { VERIFICATION_FILES, verificationNames, verificationPaths };
