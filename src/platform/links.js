/**
 * The two addresses a shop is handed out at, built by the server that serves
 * them.
 *
 * A hosted app cannot know its own address: the process sees `0.0.0.0:3000`,
 * never `erp-rust-one.vercel.app`. The request is the only thing that carries
 * it — the proxy in front of the app puts the address the visitor actually
 * typed into `x-forwarded-host`, and the scheme it was reached over into
 * `x-forwarded-proto`. `config.publicUrl` covers the case where there is no
 * request to ask.
 *
 * This is not cosmetic. The owner reads these two links off the screen and
 * sends them to their staff and their customers; a wrong one is a dead link in
 * somebody else's hands, found out later and by the wrong person. That is also
 * why the console never builds one itself.
 */
import config from '../config/index.js';

/** A proxy chain appends: `x-forwarded-host: shop.example, internal.lb`. */
const first = (value) => String(Array.isArray(value) ? value[0] : (value || ''))
  .split(',')[0]
  .trim();

export function publicBaseUrl(req) {
  const headers = req?.headers || {};
  // Only the host part: a header carrying a path or trailing junk would
  // otherwise end up glued in front of `/t/<slug>`.
  const host = (first(headers['x-forwarded-host']) || first(headers.host)).split('/')[0];
  if (!host) return config.publicUrl;

  const proto = first(headers['x-forwarded-proto'])
    // Direct, no proxy: a shop PC on the LAN, or a test hitting 127.0.0.1.
    || (req?.socket?.encrypted ? 'https' : 'http');
  return `${proto}://${host}`;
}

/**
 * `erp` is the till and the back office, `shop` is the storefront customers
 * see. With no base to build on (no request, nothing configured) both stay
 * relative, which still works in a browser and is honest about what is known.
 */
export const tenantLinks = (base, slug) => ({
  erp: `${base}/t/${slug}`,
  shop: `${base}/t/${slug}/shop`,
});

export default { publicBaseUrl, tenantLinks };
