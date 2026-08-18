/**
 * Hash routing, the same shape the ERP uses.
 *
 * The hash — rather than the History API — is what lets the whole storefront be
 * one static file served from any path, with no server rewrite beyond the
 * `/shop*` catch-all that already exists. `/shop#/product/12` is a real,
 * shareable link.
 */

const routes = [];
let notFound = null;
let container = null;
let cleanup = null;
let onRendered = null;

/** `#/product/12?x=1` → { path: 'product/12', segments: ['product','12'], query: {x:'1'} } */
export function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  const query = Object.fromEntries(new URLSearchParams(queryPart || ''));
  return { path: segments.join('/'), segments, query, raw };
}

/** Patterns look like 'product/:id'. No regex dialect to learn, and no library. */
function match(pattern, segments) {
  const parts = pattern.split('/').filter(Boolean);
  if (parts.length !== segments.length) return null;
  const params = {};
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i].startsWith(':')) params[parts[i].slice(1)] = segments[i];
    else if (parts[i] !== segments[i]) return null;
  }
  return params;
}

export function defineRoutes(map, options = {}) {
  for (const [pattern, handler] of Object.entries(map)) routes.push([pattern, handler]);
  notFound = options.notFound || notFound;
  onRendered = options.onRendered || onRendered;
}

export function navigate(path, { replace = false } = {}) {
  const target = path.startsWith('#') ? path : `#/${path.replace(/^\//, '')}`;
  if (replace) window.location.replace(target);
  else window.location.hash = target;
}

export const href = (path) => `#/${String(path).replace(/^\//, '')}`;

let renderToken = 0;

export async function render() {
  if (!container) return;
  const route = parseHash();
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

export function start(target) {
  container = target;
  window.addEventListener('hashchange', () => { render(); });
  return render();
}

/** Re-run the current view — used when the language changes under it. */
export const refresh = () => render();
