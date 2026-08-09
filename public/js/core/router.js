/** Hash router. Routes render into a container and may return a cleanup fn. */

const routes = new Map();
let notFound = null;
let currentCleanup = null;
let container = null;
let beforeEach = null;

export function defineRoutes(map, options = {}) {
  for (const [path, handler] of Object.entries(map)) routes.set(path, handler);
  notFound = options.notFound || notFound;
  beforeEach = options.beforeEach || beforeEach;
}

export function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean);
  const query = Object.fromEntries(new URLSearchParams(queryPart || ''));
  return { path: segments[0] || 'dashboard', segments, query, raw };
}

export function navigate(path, replace = false) {
  const target = path.startsWith('#') ? path : `#/${path.replace(/^\//, '')}`;
  if (replace) window.location.replace(target);
  else window.location.hash = target;
}

export async function render() {
  if (!container) return;
  const route = parseHash();
  if (beforeEach && (await beforeEach(route)) === false) return;

  if (typeof currentCleanup === 'function') {
    try { currentCleanup(); } catch { /* view cleanup is best-effort */ }
  }
  currentCleanup = null;

  const handler = routes.get(route.path) || notFound;
  container.innerHTML = '';
  try {
    const result = await handler(container, route);
    if (typeof result === 'function') currentCleanup = result;
  } catch (error) {
    container.innerHTML = '';
    container.append(Object.assign(document.createElement('div'), {
      className: 'empty',
      textContent: error?.message || 'Failed to open this screen',
    }));
    // eslint-disable-next-line no-console
    console.error(error);
  }
  window.scrollTo({ top: 0 });
  window.dispatchEvent(new CustomEvent('route:changed', { detail: route }));
}

export function startRouter(target) {
  container = target;
  window.addEventListener('hashchange', render);
  return render();
}
