/**
 * A module that ships after a shop was created still has to reach that shop.
 *
 * `tenant_modules` is the list of features a tenant is entitled to, and it is
 * written once when the tenant is created and then only when the owner edits
 * it. That was fine while the module list was fixed. The moment a release adds
 * one, every existing shop is silently short of it: `moduleEnabled()` in the
 * ERP's own store hides any nav entry whose module the tenant does not hold,
 * so the feature ships, deploys, answers on its API — and simply is not there.
 *
 * That is exactly what happened with `costs` and `employees`. The code was
 * live, the routes answered 401 rather than 404, every test passed, and the
 * owner said "nothing changed", because for him nothing had.
 *
 * The fix cannot be "give every tenant every module": the platform SELLS
 * modules, and a shop on the small package must not wake up holding the costs
 * page it did not pay for. So the rule is narrower, and it turns on a
 * distinction the data already makes:
 *
 *   A tenant that holds EVERY module that existed before this release is not a
 *   restricted tenant — it is a full one, and a full tenant stays full.
 *   A tenant missing even one of those was deliberately limited by the owner,
 *   and nothing here will quietly widen what he limited.
 *
 * `INTRODUCED_IN` is the ledger that makes "existed before this release"
 * answerable. Every module key in `MODULES` must appear in it; the test beside
 * this file fails if one is added without a date, because a module nobody
 * dated is a module this rule cannot reason about and would silently withhold.
 */
import { MODULES } from '../shared/permissions.js';
import { platformDb } from './db.js';
import { forgetTenant } from '../api/middleware/tenant.js';

/**
 * When each module first shipped, as a plain sortable date.
 *
 * `'0'` means "was here before anybody counted" — the original module set. A
 * new module gets the date of the release that adds it, and from that moment a
 * tenant created before that date can be told apart from one created after.
 */
export const INTRODUCED_IN = {
  dashboard: '0',
  suppliers: '0',
  brands: '0',
  categories: '0',
  attributes: '0',
  products: '0',
  inventory: '0',
  purchases: '0',
  customers: '0',
  sales: '0',
  promotions: '0',
  reports: '0',
  users: '0',
  labels: '0',
  settings: '0',
  audit: '0',
  weborders: '0',
  costs: '2026-08-23',
  employees: '2026-08-23',
};

/** Modules introduced strictly after `since` — the ones a tenant may be short of. */
export function modulesAddedAfter(since) {
  return Object.keys(MODULES).filter((key) => (INTRODUCED_IN[key] || '0') > since);
}

/** Everything that already existed at `since` — what a "full" tenant should hold. */
export function modulesExistingAt(since) {
  return Object.keys(MODULES).filter((key) => (INTRODUCED_IN[key] || '0') <= since);
}

/** The newest introduction date in the ledger — "this release", derived not typed. */
export const latestIntroduction = () => Object.values(INTRODUCED_IN).sort().at(-1) || '0';

/**
 * What one tenant should gain, given what it holds.
 *
 * Pure, and exported for the test: the decision is the whole feature, and it
 * should be provable without a database.
 */
export function upgradeFor(held, at = latestIntroduction()) {
  const has = new Set(held);
  const added = modulesAddedAfter(previousTo(at));
  // Nothing new since the tenant's entitlements were written.
  if (!added.length) return [];
  // Was this tenant full BEFORE the new arrivals? Judge it only on the modules
  // that existed then — the new ones are precisely what it cannot be blamed
  // for missing.
  const wasFull = modulesExistingAt(previousTo(at)).every((key) => has.has(key));
  if (!wasFull) return [];
  return added.filter((key) => !has.has(key));
}

/** The instant just before `at`, so `> previousTo(at)` means "introduced at `at`". */
const previousTo = (at) => {
  const dates = [...new Set(Object.values(INTRODUCED_IN))].sort();
  const index = dates.indexOf(at);
  return index > 0 ? dates[index - 1] : '0';
};

/**
 * Grant every full tenant the modules this release introduced.
 *
 * Idempotent — `INSERT OR IGNORE` on the composite primary key — so it is safe
 * on every boot and safe to run twice at once. Never throws into a caller: a
 * control plane that cannot be read is a problem for the console, not a reason
 * for a shop's till to stop opening, which is the same rule
 * `ensureDefaultTenant` follows next door.
 */
export async function upgradeTenantModules({ log = console } = {}) {
  const at = latestIntroduction();
  if (at === '0') return { at, granted: [] };

  let db;
  try {
    db = platformDb();
  } catch {
    return { at, granted: [] };
  }

  const granted = [];
  try {
    const tenants = await db.prepare('SELECT id, slug FROM tenants').all();
    for (const tenant of tenants) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await db
        .prepare('SELECT module FROM tenant_modules WHERE tenant_id = ?')
        .all(tenant.id);
      const missing = upgradeFor(rows.map((r) => r.module), at);
      if (!missing.length) continue;

      for (const module of missing) {
        // eslint-disable-next-line no-await-in-loop
        await db
          .prepare('INSERT OR IGNORE INTO tenant_modules (tenant_id, module) VALUES (?, ?)')
          .run(tenant.id, module);
      }
      // The request path caches the tenant's row, modules included, so a shop
      // that has just been granted one must not have to wait out a TTL.
      forgetTenant(tenant.slug);
      granted.push({ slug: tenant.slug, modules: missing });
      log?.log?.(`✔ ${tenant.slug} gained ${missing.join(', ')} — it holds every earlier module.`);
    }
  } catch (error) {
    log?.warn?.(`Could not upgrade tenant modules: ${error.message}`);
  }
  return { at, granted };
}

export default { upgradeTenantModules, upgradeFor, INTRODUCED_IN };
