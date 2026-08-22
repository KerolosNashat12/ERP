/**
 * What the page is willing to believe.
 *
 * Everything in the landing document arrives from a form the owner typed into,
 * and three of its fields end up inside an attribute rather than as text: an
 * image `src`, a `tel:` and a `wa.me` address, and a `mailto:`. Those are the
 * only places a string can stop being content and start being an instruction,
 * so they are the only strings that get a gate — and the gates live here,
 * apart from the renderer, because a guard that cannot be tested on its own
 * tends not to be.
 *
 * That is not hypothetical. `safeAsset` shipped matching the whole URL against
 * one anchored regex, which rejected the only asset URL the server ever mints
 * (it carries a `?v=<hash>` cache key). The owner uploaded his logo, the
 * console showed it, the API served it, and the page quietly kept wearing its
 * monogram. Nothing failed loudly; a feature simply did not work. These
 * functions now have `tests/kj-landing-guards.test.js` around them.
 */

/** Digits only, in the shape wa.me wants: country code, no plus, no spaces. */
export function intlPhone(raw) {
  const digits = String(raw ?? '').replace(/\D+/g, '');
  if (!digits) return '';
  if (digits.startsWith('20')) return digits;
  if (digits.startsWith('0')) return `20${digits.slice(1)}`;
  return digits;
}

/** An address, or nothing. No scheme, no space, no newline can get through. */
export function safeEmail(raw) {
  const value = String(raw ?? '').trim();
  return /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(value) ? value : '';
}

/**
 * An image URL the page is willing to load. Only the control plane's own asset
 * route and this repo's own folder — a document that says `javascript:` or
 * points at somebody else's host gets nothing, and the built-in is used.
 *
 * The PATH is what is checked, not the whole string, and that is the lesson
 * this function was taught the hard way. It used to match the string with one
 * regex ending in `$`, which meant it silently rejected the only URL the
 * server ever actually mints: the asset route carries a `?v=<hash>` so a
 * replaced logo appears immediately while the old bytes stay cacheable, and
 * `/api/landing/asset/logo?v=645f…` failed the test. An owner uploaded his
 * logo, the console showed it, the API served it, and the page quietly wore
 * its monogram instead — a whole feature defeated by a `$`.
 *
 * So the shape of the query is no longer this file's business. It takes the
 * path apart, checks that, and allows exactly one search parameter — `v`, the
 * cache key — dropping anything else rather than refusing the URL over it.
 */
export function safeAsset(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  // A relative URL only: `base` is thrown away, but it is what lets `URL`
  // parse a path, and any absolute URL a document tries to smuggle in keeps
  // its own origin here and fails the pathname test below.
  let url;
  try {
    url = new URL(value, 'https://kj.invalid/');
  } catch {
    return '';
  }
  if (url.origin !== 'https://kj.invalid') return '';
  const ok = /^\/(api\/landing\/asset\/[A-Za-z0-9._-]+|kj\/[A-Za-z0-9._/-]+)$/.test(url.pathname);
  if (!ok) return '';
  const version = url.searchParams.get('v');
  return /^[A-Za-z0-9]{1,64}$/.test(String(version ?? ''))
    ? `${url.pathname}?v=${version}`
    : url.pathname;
}
