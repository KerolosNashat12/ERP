/**
 * Routing on real addresses.
 *
 * ── What changed, and what it cost ───────────────────────────────────────────
 * This router used to put the page in the fragment: `/shop#/product/12`. That
 * made the whole storefront one static file with no server route behind it,
 * which was the right trade until the shop needed to be found. A fragment is
 * not an address to a crawler — it is never sent to the server, so Google saw
 * exactly one page per shop and the catalogue did not exist. Now the page is in
 * the path, `/shop/product/12/<slug>`, the server renders that page's own head
 * into the shell before it sends it (src/api/routes/storefrontPages.js), and
 * this file keeps the browsing itself exactly as instant as it was: a click is
 * intercepted, the view is swapped, and nothing is fetched twice.
 *
 * ── Nobody's link breaks ─────────────────────────────────────────────────────
 * `#/product/12` is in WhatsApp threads, in bookmarks and in messages nobody
 * can go back and edit. The fragment never reaches the server, so this is the
 * one translation that HAS to happen in the browser, and it happens before the
 * first render: the hash is read, turned into the path it now means, and
 * `replaceState`d — so the customer lands on the right page, the back button
 * does not bounce between two spellings of it, and the head the server already
 * sent for `/shop` names the shop rather than nothing. New links are paths; old
 * links are paths a moment after they open. See `legacyHashRoute`.
 *
 * ── Where the shop starts ────────────────────────────────────────────────────
 * `/shop` on a single-shop deployment, `/t/<slug>/shop` on the platform, and
 * whatever a customer's own domain resolves to tomorrow — read off the address
 * bar, never configured, exactly as `core/api.js` reads its API prefix.
 */
import {
  shopRootFrom, routeSegments, legacyHashRoute, withLanguage,
} from '../../../shared/shopUrls.js';
import { getLanguage } from './i18n.js';

const routes = [];
let notFound = null;
let container = null;
let cleanup = null;
let onRendered = null;

/** Where this shop's addresses begin. Fixed for the life of the page. */
let root = null;
export function shopRoot() {
  if (root === null) root = shopRootFrom(window.location.pathname).root;
  return root;
}

/**
 * `/shop/product/12/x?c=1` -> { path: 'product/12/x', segments: [...], query: {c:'1'} }
 *
 * The same shape `parseHash` used to return, so every view that reads
 * `route.params`, `route.segments` or `route.query` is untouched.
 */
export function currentRoute() {
  const segments = routeSegments(window.location.pathname, shopRoot());
  const query = Object.fromEntries(new URLSearchParams(window.location.search));
  return { path: segments.join('/'), segments, query, raw: segments.join('/') };
}

/**
 * Patterns look like 'product/:id' or 'product/:id/:slug?'. No regex dialect to
 * learn, and no library. A trailing `?` marks a segment that may be missing —
 * which is what lets `/shop/product/12` and `/shop/product/12/سلسلة-فضة` be the
 * same page, so a slug trimmed out of a forwarded message still arrives.
 */
function match(pattern, segments) {
  const parts = pattern.split('/').filter(Boolean);
  const required = parts.filter((part) => !part.endsWith('?')).length;
  if (segments.length < required || segments.length > parts.length) return null;
  const params = {};
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i].replace(/\?$/, '');
    if (i >= segments.length) break;
    if (part.startsWith(':')) params[part.slice(1)] = segments[i];
    else if (part !== segments[i]) return null;
  }
  return params;
}

export function defineRoutes(map, options = {}) {
  for (const [pattern, handler] of Object.entries(map)) routes.push([pattern, handler]);
  notFound = options.notFound || notFound;
  onRendered = options.onRendered || onRendered;
}

/**
 * A link to a page of this shop.
 *
 * Absolute URLs pass through untouched — the banner's call-to-action is a link
 * the owner typed, and it may well point at Instagram. Everything else is
 * resolved against the shop's root and carries the language the customer is
 * reading in, so a link they copy out of the address bar opens in the language
 * they were shown. Arabic is the bare address; English adds `?lang=en`, and
 * those two are exactly the pair the `hreflang` tags in the head declare.
 */
export function href(path) {
  const value = String(path ?? '');
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) return value;
  if (value.startsWith('#')) return value;
  const clean = value.replace(/^\/+/, '');
  const [pathPart, queryPart] = clean.split('?');
  const url = pathPart ? `${shopRoot()}/${pathPart}` : shopRoot();
  return withLanguage(url, getLanguage(), { keepQuery: queryPart || '' });
}

/** Go somewhere. Accepts a route ('products') or an address ('/shop/products'). */
export function navigate(path, { replace = false } = {}) {
  const target = String(path).startsWith('/') ? String(path) : href(path);
  const current = window.location.pathname + window.location.search;
  if (target === current && !replace) return render();
  window.history[replace ? 'replaceState' : 'pushState']({}, '', target);
  return render();
}

/**
 * Move the address bar onto the page's canonical spelling without touching
 * history — used once a product's real name is known, so a link arriving as
 * `/shop/product/12` becomes `/shop/product/12/<slug>` in the bar the customer
 * copies from. Never a navigation: same page, better spelling.
 */
export function canonicalise(path) {
  const target = String(path).startsWith('/') ? String(path) : href(path);
  if (target === window.location.pathname + window.location.search) return;
  window.history.replaceState({}, '', target);
}

let renderToken = 0;

export async function render() {
  if (!container) return;
  const route = currentRoute();
  // A view that is slow to load must not be able to paint over the page the
  // customer has since navigated to.
  const token = (renderToken += 1);

  if (typeof cleanup === 'function') {
    try { cleanup(); } catch { /* cleanup is best-effort */ }
  }
  cleanup = null;

  let handler = notFound;
  let params = {};
  for (const [pattern, candidate] of routes) {
    const found = match(pattern, route.segments);
    if (found) { handler = candidate; params = found; break; }
  }

  const view = { ...route, params };
  container.replaceChildren();
  const result = await handler(container, view);
  if (token !== renderToken) return;
  if (typeof result === 'function') cleanup = result;

  if (onRendered) onRendered(view);
}

/**
 * One listener for every link on the site.
 *
 * With paths instead of fragments, an un-intercepted click is a full page load:
 * a new HTML document, a new module graph, a new set of requests. On a phone on
 * Egyptian mobile data that is the difference between browsing a shop and
 * waiting for one. So same-shop links are handled here and the page is swapped
 * in place, exactly as it was when every link was a fragment.
 *
 * Everything else is left completely alone — another origin, a `target`, a
 * download, a modified click (a customer opening a product in a new tab), the
 * `#main` skip link, and any link that leaves the storefront for the ERP or the
 * marketing page.
 */
function interceptClicks() {
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target.closest?.('a[href]');
    if (!anchor || anchor.target || anchor.hasAttribute('download')) return;
    if ((anchor.getAttribute('rel') || '').includes('external')) return;

    let url;
    try { url = new URL(anchor.href, window.location.href); } catch { return; }
    if (url.origin !== window.location.origin) return;
    if (!url.pathname.startsWith(shopRoot())) return;
    // An in-page anchor — the skip link — is the browser's job, not ours.
    if (url.hash && url.pathname === window.location.pathname && url.search === window.location.search) return;

    event.preventDefault();
    navigate(url.pathname + url.search);
  });
}

export function start(target) {
  container = target;

  /**
   * The old address, adopted before anything is drawn. `legacyHashRoute`
   * returns null for a fragment that was never one of ours, so `#main` and any
   * future in-page anchor are untouched.
   */
  const legacy = legacyHashRoute(window.location.hash);
  if (legacy !== null) window.history.replaceState({}, '', href(legacy));

  window.addEventListener('popstate', () => { render(); });
  interceptClicks();
  return render();
}

/** Re-run the current view — used when the language changes under it. */
export const refresh = () => render();
