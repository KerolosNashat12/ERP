/**
 * Is this shop's website switched on?
 *
 * Extracted from `api/routes/shop.js`, where it has guarded the storefront API
 * since the switch existed, because the storefront's PAGES, its `robots.txt`
 * and its `sitemap.xml` need exactly the same answer and a second
 * implementation of "is this shop open to the public" is a second thing to get
 * wrong. One gate, mounted in front of everything a member of the public can
 * reach.
 *
 * A tenant that has switched its website off must not leak that a shop even
 * exists there — so this is a plain 404, the same shape `notFoundHandler`
 * would produce, not a 403 that would confirm something is behind the door.
 * With no tenant resolved (the single-shop build), `currentTenant()` is null
 * and nothing changes.
 */
import { currentTenant } from '../../infrastructure/database/connection.js';
import { confirmTenant } from './tenant.js';

/**
 * `json` for an API route, `plain` for a page or a sitemap — a crawler asking
 * for `/t/x/sitemap.xml` should get the same nothing a browser would, not a
 * JSON error object wearing an XML content type.
 */
export function websiteGate({ shape = 'json' } = {}) {
  return async function gate(req, res, next) {
    const tenant = currentTenant();
    if (!tenant || tenant.websiteEnabled) return next();

    // Before closing a storefront, ask the control plane again. This instance's
    // cached row may have been written by another one — and a shop that is open
    // being told it is closed, in front of its customers, is the one failure this
    // gate must never produce. Only a refusal that survives a fresh read stands.
    try {
      const confirmed = await confirmTenant(tenant.slug);
      if (confirmed && confirmed.websiteEnabled) {
        tenant.websiteEnabled = true;
        return next();
      }
    } catch {
      // The control plane being unreachable is not a reason to open a door the
      // owner closed; fall through to the 404 below.
    }

    if (shape === 'json') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` } });
    }
    return res.status(404).end();
  };
}

export default websiteGate;
