/**
 * What a storefront address looks like — written once, read by both sides.
 *
 * The browser builds these links and the server has to resolve the very same
 * strings back into a page before any script runs, so the shape of a URL cannot
 * live in the router alone. It lives here, and `src/services/StorefrontSeo.js`
 * imports this exact file: the ERP cannot `import` into the browser, but Node
 * can read a plain ES module out of `public/`, and one file that both sides
 * agree on is the only way `/shop/product/12/…` cannot come to mean two things.
 *
 * ── The shape ────────────────────────────────────────────────────────────────
 *   <prefix>/shop                      the shop's front page
 *   <prefix>/shop/products             everything
 *   <prefix>/shop/category/3/<slug>    a shelf
 *   <prefix>/shop/brand/7/<slug>       a maker
 *   <prefix>/shop/product/12/<slug>    one piece
 *   <prefix>/shop/search?q=…           a search  (never indexed)
 *   <prefix>/shop/cart | checkout | track | order/<no> | favorites | contact
 *
 * `<prefix>` is '' on a single-shop deployment and `/t/<slug>` on the platform,
 * and it is read off the address bar rather than configured — the same bundle
 * serves both, exactly as `core/api.js` already does for the API.
 *
 * ── Why the id comes before the slug ─────────────────────────────────────────
 * The slug is for the human and the crawler; the id is what resolves. A product
 * renamed in the ERP, a slug somebody trimmed out of a WhatsApp message, a link
 * from before this file existed — all of them still land on the right page,
 * and the page says which address is canonical. Nothing about a page ever
 * depends on the slug being right, which is what makes it safe to put a shop's
 * own Arabic wording in a URL.
 */

/** The one query parameter that changes what language a page is served in. */
export const LANG_PARAM = 'lang';

/** Arabic is the shop's default, so the bare URL is the Arabic one. */
export const DEFAULT_LANG = 'ar';
export const LANGUAGES = ['ar', 'en'];

/** Longest a slug may get. Long enough to read, short enough to paste. */
const SLUG_MAX = 60;

/** Arabic diacritics and the tatweel — decoration, never part of a word. */
const ARABIC_MARKS = /[ً-ْٰـ]/g;

/**
 * A product's own name, turned into something that can sit in a URL.
 *
 * Arabic letters are KEPT. A URL is UTF-8 and both Google and every browser
 * show `%D8%B3…` back to a human as the word it is, so transliterating an
 * Egyptian shop's product names into Latin would throw away the only words its
 * customers actually search for. Everything that is not a letter or a digit
 * becomes a single dash; runs collapse; the ends are trimmed.
 */
export function slugify(text) {
  const raw = String(text ?? '').trim().replace(ARABIC_MARKS, '');
  if (!raw) return '';
  const cut = raw
    .toLowerCase()
    .replace(/[‘’“”'"]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  if (cut.length <= SLUG_MAX) return cut;
  // Cut on a word boundary rather than mid-word, but never to nothing.
  const trimmed = cut.slice(0, SLUG_MAX);
  const lastDash = trimmed.lastIndexOf('-');
  return (lastDash > SLUG_MAX / 3 ? trimmed.slice(0, lastDash) : trimmed).replace(/-+$/, '');
}

/**
 * One slug per thing, in one language, whichever language the page is read in.
 *
 * Arabic when the shop wrote an Arabic name, English otherwise. The alternative
 * — a slug per language — would make the two language versions of a page differ
 * in two ways at once, and the language variant is already carried by `?lang=`,
 * which is what `hreflang` points at. So the slug stays constant and decorative.
 */
export const slugFor = (row, field = 'name') => slugify(
  (row && (row[`${field}_ar`] || row[`${field}_en`])) || '',
);

/**
 * Where the storefront starts, read off a pathname.
 *
 * `/t/mm/shop/product/12/x` -> { prefix: '/t/mm', root: '/t/mm/shop' }
 * `/shop`                   -> { prefix: '',      root: '/shop' }
 */
export function shopRootFrom(pathname) {
  const match = String(pathname || '').match(/^(\/t\/[a-z0-9][a-z0-9-]{0,30})?\/shop(?:\/|$)/i);
  const prefix = (match && match[1]) || '';
  return { prefix, root: `${prefix}/shop` };
}

/** The part of a pathname that belongs to the router: `product/12/x`. */
export function routeSegments(pathname, root) {
  const path = String(pathname || '');
  const rest = path.startsWith(root) ? path.slice(root.length) : path;
  return rest.split('/').filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
}

/** `product/12/silver-chain` for a route name and its parameters. */
export function routePath(name, params = {}) {
  const id = params.id !== undefined && params.id !== null ? String(params.id) : '';
  const slug = params.slug ? `/${encodeURIComponent(params.slug)}` : '';
  switch (name) {
    case 'home': return '';
    case 'product': return `product/${encodeURIComponent(id)}${slug}`;
    case 'category': return `category/${encodeURIComponent(id)}${slug}`;
    case 'brand': return `brand/${encodeURIComponent(id)}${slug}`;
    case 'order': return `order/${encodeURIComponent(params.orderNo ?? '')}`;
    default: return name;
  }
}

/** A whole address: `/t/mm/shop/product/12/x`. */
export function shopUrl(root, name, params = {}) {
  const path = routePath(name, params);
  return path ? `${root}/${path}` : root;
}

/**
 * Every address a customer already has, still pointing somewhere real.
 *
 * `#/product/12` was a real link for as long as this shop has existed and it is
 * sitting in WhatsApp threads, in bookmarks and in messages nobody can edit. The
 * hash never reaches the server, so this is the one translation that HAS to
 * happen in the browser: read the fragment, turn it into the path it now means,
 * and replace it in history so the customer's back button does not bounce
 * between the two. Returns null for anything that is not one of ours, so a
 * plain `#main` skip-link anchor is left completely alone.
 */
export function legacyHashRoute(hash) {
  const raw = String(hash || '');
  if (!raw.startsWith('#/')) return null;
  const [pathPart, queryPart] = raw.slice(2).split('?');
  const segments = pathPart.split('/').filter(Boolean);
  const query = queryPart ? `?${queryPart}` : '';
  if (!segments.length) return query || '';
  return `${segments.map(encodeURIComponent).join('/')}${query}`;
}

/**
 * The language a request is asking for. Anything that is not a language this
 * shop speaks is the default — a crawler that invents `?lang=fr` must not be
 * shown a third version of the page.
 */
export const languageFrom = (value) => (LANGUAGES.includes(String(value || '')) ? String(value) : DEFAULT_LANG);

/**
 * The same page, in one language.
 *
 * Arabic is the bare URL — it is what customers already share and what the shop
 * is written in — and English adds `?lang=en`. Two addresses, each serving one
 * language, which is the only arrangement `hreflang` can honestly describe.
 */
export function withLanguage(url, lang, { keepQuery = '' } = {}) {
  const query = keepQuery ? `${keepQuery.startsWith('?') ? '' : '?'}${keepQuery}` : '';
  const joiner = query ? '&' : '?';
  if (lang === 'en') return `${url}${query}${joiner}${LANG_PARAM}=en`;
  return `${url}${query}`;
}

export default {
  LANG_PARAM, DEFAULT_LANG, LANGUAGES,
  slugify, slugFor, shopRootFrom, routeSegments, routePath, shopUrl,
  legacyHashRoute, languageFrom, withLanguage,
};
