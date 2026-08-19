/**
 * Turns `/t/:slug/...` into a request scoped to one tenant's own database.
 *
 * Three outcomes for the slug itself, decided before anything about the
 * request's contents is even looked at:
 *   - unknown slug        -> 404 (never a redirect — that would let a visitor
 *                             tell a real shop apart from a typo)
 *   - status 'suspended'  -> 423
 *   - otherwise           -> the tenant's connection is opened (or reused)
 *                             and the rest of the request runs inside
 *                             `runWithTenant`, exactly like every other
 *                             tenant-scoped request in the codebase.
 *
 * Tenant rows are cached in memory — the control plane is a database, and no
 * route should pay that lookup on every single request. `forgetTenant` drops a
 * row the moment `TenantService` writes to it (suspend, resume, limits, module
 * changes, the website switch), and also drops that tenant's open connection so
 * a changed credential or driver is never talked to with the old one.
 *
 * That invalidation is not enough on its own, and the reason cost a live shop
 * its storefront: a serverless deployment runs many instances of this process,
 * each with its own copy of this Map. Switching a shop's website off in the
 * console reaches exactly one of them. Every other instance keeps serving the
 * old answer — and because the cache had no expiry, "old" meant *forever*, so
 * the storefront came back 404 or 200 depending on which instance answered.
 * Switching it back on left the same coin-flip in place.
 *
 * So entries also expire. The TTL is the longest a change can take to reach an
 * instance that did not handle it: short enough that toggling something in the
 * console visibly takes effect, long enough that the control plane is not read
 * on every request of a busy shop.
 */
import { platformDb } from '../../platform/db.js';
import { connectionFor, forget as forgetConnection } from '../../infrastructure/database/connections.js';
import { openConnection, runWithTenant } from '../../infrastructure/database/connection.js';
import { MODULES } from '../../shared/permissions.js';

const cache = new Map();

/** Milliseconds an entry may be served before it is read again. */
const TTL_MS = Number(process.env.MM_TENANT_CACHE_MS || 15_000);

async function fetchTenant(slug) {
  const db = platformDb();
  const row = await db.prepare('SELECT * FROM tenants WHERE slug = ?').get(slug);
  if (!row) return null;

  const moduleRows = await db.prepare('SELECT module FROM tenant_modules WHERE tenant_id = ?').all(row.id);
  return {
    id: row.id,
    slug: row.slug,
    name: row.name_en,
    nameAr: row.name_ar,
    status: row.status,
    driver: row.driver,
    dbFile: row.db_file,
    dbUrl: row.db_url,
    dbAuthToken: row.db_auth_token,
    websiteEnabled: Boolean(row.website_enabled),
    // Only real module names ever end up in the enabled set — a stray row
    // (from a module retired after the tenant was provisioned) is dropped
    // silently rather than granted.
    modules: new Set(moduleRows.map((m) => m.module).filter((m) => m in MODULES)),
    limits: { maxUsers: row.max_users, maxProducts: row.max_products },
  };
}

/** Cached lookup — the only place that reads the `tenants` table per-request. */
export async function loadTenant(slug) {
  const hit = cache.get(slug);
  if (hit && hit.expires > Date.now()) return hit.tenant;

  const tenant = await fetchTenant(slug);
  cache.set(slug, { tenant, expires: Date.now() + TTL_MS });
  return tenant;
}

/**
 * Drop a tenant from both caches: the row cache here, and the open-connection
 * cache in `connections.js`. Called by `TenantService` on every write, so a
 * suspend, a limit change or a rotated credential is visible on the very next
 * request — never stale for the lifetime of the process.
 */
export async function forgetTenant(slug) {
  cache.delete(slug);
  await forgetConnection(slug);
}

/**
 * The same resolution, for a slug that comes from configuration rather than the
 * URL.
 *
 * A deployment that served one shop before it served a fleet keeps answering at
 * its old addresses — `/`, `/shop`, `/api/…` with no prefix. A redirect is not
 * enough on its own: a host that serves `public/` as static files answers
 * `/shop` from the CDN before the application is reached, so the page loads at
 * the old address whatever the application would have preferred, and then calls
 * the old API paths. Those paths therefore have to keep working, and this is
 * what makes them mean "the default shop" instead of "no shop at all".
 */
export const resolveDefaultTenant = (slug) => (req, res, next) => resolve(slug, req, res, next);

export async function resolveTenant(req, res, next) {
  return resolve(req.params.slug, req, res, next);
}

async function resolve(slug, req, res, next) {
  try {
    const tenant = await loadTenant(slug);

    if (!tenant) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: `No shop at "${slug}"` } });
    }
    if (tenant.status === 'suspended') {
      return res.status(423).json({
        error: { code: 'TENANT_SUSPENDED', message: 'This shop is currently suspended' },
      });
    }

    const connection = await connectionFor(slug, () => openConnection({
      driver: tenant.driver || 'sqlite',
      file: tenant.dbFile,
      url: tenant.dbUrl,
      authToken: tenant.dbAuthToken,
    }));

    const tenantContext = {
      slug: tenant.slug,
      name: tenant.name,
      modules: tenant.modules,
      limits: tenant.limits,
      websiteEnabled: tenant.websiteEnabled,
    };

    req.tenant = tenantContext;
    return runWithTenant(tenantContext, connection, next);
  } catch (error) {
    return next(error);
  }
}

export default { resolveTenant, resolveDefaultTenant, forgetTenant, loadTenant };
