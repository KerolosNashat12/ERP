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
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * REMEMBERED STATE — what happens when the control plane cannot be read at all
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Everything above assumes the control plane answers. One database resolves
 * every request on this platform, and when it blinked, nothing resolved: not a
 * till mid-sale, not a customer mid-checkout. A shop that was trading a minute
 * ago vanished because a database somewhere else was busy.
 *
 * So a descriptor that was read successfully is also KEPT, separately from the
 * TTL cache above, and used when — and only when — a read of the control plane
 * FAILS. Two clocks, two different jobs:
 *
 *   TTL_MS   (15s)  how long a good answer may be reused while the control
 *                   plane is healthy. Unchanged, and the hot path is untouched:
 *                   a cache hit still costs one Map lookup and no I/O.
 *   GRACE_MS (15m)  how long a *remembered* answer may stand in for one that
 *                   cannot be read at all. The clock runs from the last
 *                   SUCCESSFUL read of that shop's row, not from the last
 *                   request — so a busy shop does not extend its own grace by
 *                   being busy.
 *
 * ── Which decisions may be made from a remembered descriptor ─────────────────
 *
 * ALLOWED, up to GRACE_MS:
 *   - Keep serving a shop this instance already knew to be active: the ERP, the
 *     till, the storefront. This is the whole point. The alternative — refusing
 *     — is a certain outage in every shop in exchange for avoiding an unlikely
 *     one in one shop.
 *   - The modules and limits on that descriptor. A shop briefly keeping a
 *     module it just lost, or adding one user past a limit that was just
 *     lowered, is a rounding error; both are re-read the moment the control
 *     plane answers again.
 *   - `websiteEnabled`, for the same window. An owner who switches his website
 *     off expects it off — but "off within fifteen minutes of an outage" is not
 *     the bug. "Still serving customers an hour later" is, and that is what the
 *     bound exists to make impossible.
 *
 * NEVER, at any age:
 *   - Inventing absence. A 404 says "there is no shop at this address", and an
 *     instance that cannot read the control plane does not know that. An
 *     unknown slug during an outage is 503 with a `Retry-After`, not 404 —
 *     which is also why only *found* rows are remembered here and absences are
 *     not: a 404 from this file is always a fresh fact.
 *   - Opening a shop this instance has never resolved. There is nothing to
 *     remember, and a cold serverless instance has no memory of anything —
 *     which is exactly what makes 503 the honest answer rather than a guess.
 *   - Overturning a refusal. If the cached row says suspended and the control
 *     plane cannot confirm it, the shop stays closed. Refusals never expire;
 *     permissions do. A suspended shop that keeps trading because the control
 *     plane is down is its own kind of bug, and this is the direction that
 *     cannot produce it.
 *   - Anything the owner's console does. Creating, suspending, re-pointing or
 *     restoring a shop reads and writes the control plane directly and is
 *     simply unavailable while it is unavailable. Not one of those decisions
 *     is safe to make from a copy.
 *
 * ── Being able to tell ───────────────────────────────────────────────────────
 * Running on memory is invisible by design — that is what makes it useful and
 * what makes it dangerous. Every answer therefore carries `X-MM-Tenant-Source`
 * (`fresh`, `cached` or `remembered`), a remembered one adds
 * `X-MM-Control-Plane: degraded` and the descriptor's age in seconds,
 * `/api/health` reports the same thing for the instance as a whole, and
 * `platform/controlPlaneHealth.js` writes one `platform_audit` row per outage
 * once the control plane can be written to again.
 */
import { platformDb } from '../../platform/db.js';
import { connectionFor, forget as forgetConnection } from '../../infrastructure/database/connections.js';
import { openConnection, runWithTenant } from '../../infrastructure/database/connection.js';
import { ensureMigrated, forgetSchema } from '../../platform/tenantSchema.js';
import { MODULES } from '../../shared/permissions.js';
import { ServiceUnavailableError } from '../../shared/errors.js';
import health from '../../platform/controlPlaneHealth.js';
import { noteTenantRequest } from '../../platform/FleetSummaryService.js';

const cache = new Map();

/**
 * The last descriptor the control plane actually gave for each slug, and when.
 * Separate from `cache` on purpose: `cache` also holds negative answers and is
 * cleared by `confirmRefusal` on the way to a fresh read, and neither of those
 * should be able to erase what this instance knows about a shop that exists.
 */
const remembered = new Map();

/**
 * A platform with many shops on a small instance must not grow this without
 * bound. Same reasoning as the connection cache in `connections.js`: keep the
 * busy shops, let the quiet ones go — a shop nobody has visited in an hour is
 * not the shop that is mid-sale when the control plane blinks.
 */
const MAX_REMEMBERED = Number(process.env.MM_TENANT_REMEMBER_MAX || 200);

/** Milliseconds an entry may be served before it is read again. */
const TTL_MS = Number(process.env.MM_TENANT_CACHE_MS || 15_000);

/**
 * Milliseconds a remembered descriptor may stand in for one that cannot be
 * read. Fifteen minutes: long enough to cover the control-plane outages that
 * actually happen (a restart, a failover, a rate limit, a network partition),
 * short enough that no commercial decision — a suspension, a website switched
 * off — can be ignored for anything an owner would describe as "an hour".
 */
const GRACE_MS = Number(process.env.MM_TENANT_GRACE_MS || 15 * 60_000);

health.setRememberedCounter(() => remembered.size);
health.setWindows({ ttlMs: TTL_MS, graceMs: GRACE_MS });

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

/** Keep what the control plane said, so an outage has something to fall back on. */
function remember(slug, tenant) {
  if (!tenant) return;
  remembered.delete(slug);
  remembered.set(slug, { tenant, at: Date.now() });
  // Map keeps insertion order, so the first key is the least recently refreshed.
  while (remembered.size > MAX_REMEMBERED) {
    remembered.delete(remembered.keys().next().value);
  }
}

/** Cached lookup — the only place that reads the `tenants` table per-request. */
export async function loadTenant(slug, { fresh = false } = {}) {
  if (!fresh) {
    const hit = cache.get(slug);
    if (hit && hit.expires > Date.now()) return hit.tenant;
  }

  let tenant;
  try {
    tenant = await fetchTenant(slug);
  } catch (error) {
    // Recorded, then re-thrown unchanged: every caller of this function already
    // decides for itself what an unreadable control plane means for what it was
    // about to do, and this must not quietly turn a failure into an answer.
    health.recordFailure(error);
    throw error;
  }
  health.recordOk();
  cache.set(slug, { tenant, expires: Date.now() + TTL_MS });
  remember(slug, tenant);
  return tenant;
}

const unavailable = () => new ServiceUnavailableError(
  'The platform cannot look this shop up right now. Please try again in a moment.',
  { retryAfter: 10, code: 'CONTROL_PLANE_UNAVAILABLE' },
);

/**
 * The descriptor to act on, and where it came from.
 *
 * `cached` and `fresh` are the two healthy answers and behave exactly as they
 * always have. `remembered` is only ever reached after a read has actually
 * failed — never as an optimisation, never to save a round trip.
 */
async function descriptorFor(slug) {
  const hit = cache.get(slug);
  if (hit && hit.expires > Date.now()) return { tenant: hit.tenant, source: 'cached', ageMs: 0 };

  try {
    return { tenant: await loadTenant(slug, { fresh: true }), source: 'fresh', ageMs: 0 };
  } catch {
    // The failure itself is already recorded by `loadTenant`, and its message
    // is deliberately not carried any further: a driver's message quotes the
    // database URL, and a URL is half of a credential.
    const kept = remembered.get(slug);
    const ageMs = kept ? Date.now() - kept.at : Infinity;
    if (kept && ageMs <= GRACE_MS) {
      health.recordServedFromMemory();
      return { tenant: kept.tenant, source: 'remembered', ageMs };
    }
    health.recordRefused();
    throw unavailable();
  }
}

/**
 * Read the control plane again before refusing a request.
 *
 * The expiry above bounds how long a stale answer can be served, but "bounded"
 * is the wrong guarantee for the answers that hurt: telling a customer a shop
 * does not exist, or telling a shop it is suspended, on the strength of a cached
 * row that another instance changed. Those three refusals are rare, so they can
 * afford one extra read — and with it, a shop that is actually open is never
 * closed by a cache. A refusal that survives this second look is a real one.
 */
async function confirmRefusal(slug) {
  cache.delete(slug);
  return loadTenant(slug, { fresh: true });
}

/**
 * Drop a tenant from every cache: the row cache here, the remembered descriptor
 * beside it, and the open-connection cache in `connections.js`. Called by
 * `TenantService` on every write, so a suspend, a limit change or a rotated
 * credential is visible on the very next request — never stale for the lifetime
 * of the process.
 *
 * The remembered copy has to go too, or a suspension made on this instance
 * would be undone by the next control-plane wobble: the write would be gone
 * from `cache`, the fresh read would fail, and the descriptor this shop was
 * suspended from would come straight back out of memory.
 */
export async function forgetTenant(slug) {
  cache.delete(slug);
  remembered.delete(slug);
  // Its schema too: the connection is being dropped, so whatever this process
  // knew about that database's shape was tied to a connection it no longer has.
  forgetSchema(slug);
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

/**
 * Say, on the answer itself, whether it was decided from the control plane or
 * from memory. Two `setHeader` calls on the healthy path and nothing else — the
 * till pays nothing for this, and anybody with `curl` can tell the difference
 * from outside without a console login.
 */
function markSource(res, source, ageMs) {
  res.setHeader('X-MM-Tenant-Source', source);
  if (source !== 'remembered') return;
  res.setHeader('X-MM-Control-Plane', 'degraded');
  res.setHeader('X-MM-Tenant-Age', String(Math.round(ageMs / 1000)));
}

async function resolve(slug, req, res, next) {
  try {
    let { tenant, source, ageMs } = await descriptorFor(slug);

    if (!tenant || tenant.status === 'suspended') {
      // Never refuse on a cached row — see confirmRefusal.
      let confirmed;
      try {
        confirmed = await confirmRefusal(slug);
      } catch {
        /**
         * The control plane cannot be asked, so this refusal cannot be checked.
         * A refusal is the safe direction and stands: a shop that was suspended
         * stays suspended. The one refusal that is NOT safe to uphold is the
         * one that says a shop does not exist — that is a fact this instance
         * does not have — so an unknown slug becomes 503 rather than 404.
         */
        health.recordRefused();
        if (!tenant) throw unavailable();
        return res.status(423).json({
          error: { code: 'TENANT_SUSPENDED', message: 'This shop is currently suspended' },
        });
      }
      if (!confirmed) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: `No shop at "${slug}"` } });
      }
      if (confirmed.status === 'suspended') {
        return res.status(423).json({
          error: { code: 'TENANT_SUSPENDED', message: 'This shop is currently suspended' },
        });
      }
      tenant = confirmed;
      source = 'fresh';
      ageMs = 0;
    }

    const connection = await connectionFor(slug, () => openConnection({
      driver: tenant.driver || 'sqlite',
      file: tenant.dbFile,
      url: tenant.dbUrl,
      authToken: tenant.dbAuthToken,
    }));

    /**
     * This shop's schema, brought up to date the first time this process serves
     * it — once per slug, and never fatal. See platform/tenantSchema.js for why
     * a platform needs this and a single shop does not.
     */
    await ensureMigrated(slug, connection);

    const tenantContext = {
      slug: tenant.slug,
      name: tenant.name,
      modules: tenant.modules,
      limits: tenant.limits,
      websiteEnabled: tenant.websiteEnabled,
    };

    req.tenant = tenantContext;
    markSource(res, source, ageMs);
    /**
     * The console's overview reads a summary of this shop rather than opening
     * its database (see platform/FleetSummaryService.js). This is the cheapest
     * place to notice that the summary has gone stale — the shop's connection
     * is open and in scope — but nothing about it may touch this request: it is
     * scheduled after the response has been written, it is rate-limited per
     * shop in memory so the common case is one Map lookup, and a failure is
     * silence. The scheduled sweep is what guarantees the summary; this only
     * keeps a busy shop's figures fresher than the sweep would.
     */
    noteTenantRequest(res, tenant, connection);
    return runWithTenant(tenantContext, connection, next);
  } catch (error) {
    return next(error);
  }
}

export default { resolveTenant, resolveDefaultTenant, forgetTenant, loadTenant, confirmTenant };

/**
 * Used by the storefront gate for the same reason `confirmRefusal` exists: a
 * shop is only told its website is off after the control plane has been asked
 * again. A customer seeing "this does not exist" because of a cache is the
 * failure this whole file is now shaped around.
 *
 * It throws when the control plane cannot be read, and its one caller catches
 * that and leaves the door shut — a closed website is a refusal, and refusals
 * are not overturned from memory.
 */
export async function confirmTenant(slug) {
  return confirmRefusal(slug);
}

/** Tests only: forget every descriptor this instance is holding. */
export function forgetEverything() {
  cache.clear();
  remembered.clear();
}

/** How many shops this instance could still serve if the control plane vanished. */
export const rememberedCount = () => remembered.size;
