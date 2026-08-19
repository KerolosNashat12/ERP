/**
 * Every network call the shop makes.
 *
 * Deliberately not the ERP's `public/js/core/api.js`: that one carries a
 * session cookie, redirects on 401 and knows about the back office. A shopper
 * has no session, so this sends no credentials and treats every failure as
 * something to show a friendly card about.
 */

/**
 * The browser learns its tenant prefix from the URL: `''` for the
 * single-shop build, `/t/<slug>` whenever the storefront was loaded under
 * `/t/<slug>/shop`. Every request and every image URL this module builds
 * goes through this, so the same bundle serves both.
 */
export function apiBase() {
  const match = window.location.pathname.match(/^\/t\/([a-z0-9][a-z0-9-]{0,30})(?:\/|$)/);
  return match ? `/t/${match[1]}` : '';
}

export class ShopError extends Error {
  constructor(message, status, code, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    /** True when the request never reached the shop at all. */
    this.offline = status === 0;
  }
}

async function request(path, { method = 'GET', body, query } = {}) {
  const url = new URL(apiBase() + path, window.location.origin);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, value);
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (cause) {
    // No network, DNS failure, server down — the caller shows the offline card.
    throw new ShopError(cause.message || 'Network error', 0, 'OFFLINE');
  }

  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }

  if (!response.ok) {
    const error = payload?.error || {};
    throw new ShopError(error.message || `Request failed (${response.status})`,
      response.status, error.code || 'ERROR', error.details);
  }
  return payload;
}

export const api = {
  config: () => request('/api/shop/config'),
  home: () => request('/api/shop/home'),
  categories: () => request('/api/shop/categories'),
  brands: () => request('/api/shop/brands'),
  products: (query) => request('/api/shop/products', { query }),
  product: (id) => request(`/api/shop/products/${encodeURIComponent(id)}`),
  placeOrder: (body) => request('/api/shop/orders', { method: 'POST', body }),
  trackOrder: (orderNo, phone) => request(`/api/shop/orders/${encodeURIComponent(orderNo)}`, { query: { phone } }),
};

/** Photo bytes come straight off the API — no CDN, no build step, no bundling. */
export const imageUrl = (id) => (id ? `${apiBase()}/api/shop/images/${id}` : null);

/**
 * A root-relative asset path from `/api/shop/config` (`branding.logo`,
 * `banner.image`), moved into this tenant's own space.
 *
 * The server answers with `/api/shop/logo` because it does not know — and must
 * not have to know — which prefix the browser reached it through. Without this
 * a shop hosted at `/t/<slug>/shop` would fetch the DEFAULT tenant's logo and
 * banner: the one bug this whole round exists to make impossible, arriving
 * through the back door of a URL nobody prefixed.
 */
export const assetUrl = (path) => (path ? `${apiBase()}${path}` : null);
