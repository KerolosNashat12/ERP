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
 * Tenant rows are cached in memory — the control plane is a database on
 * disk, and no route should pay that lookup on every single request. The
 * cache has no TTL by itself; it is only ever invalidated by `forgetTenant`,
 * which `TenantService` calls after every write (suspend, resume, limits and
 * module changes, driver changes). Forgetting also drops the tenant's open
 * connection from `connections.js`'s cache, so a tenant whose credentials or
 * driver just changed does not keep talking to its old database.
 */
import { platformDb } from '../../platform/db.js';
import { connectionFor, forget as forgetConnection } from '../../infrastructure/database/connections.js';
import { openConnection, runWithTenant } from '../../infrastructure/database/connection.js';
import { MODULES } from '../../shared/permissions.js';

const cache = new Map();

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
  if (cache.has(slug)) return cache.get(slug);
  const tenant = await fetchTenant(slug);
  cache.set(slug, tenant);
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
