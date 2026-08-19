/**
 * The shop that was here before the fleet was.
 *
 * A deployment that has been serving one shop already has everything that shop
 * needs — a database, data in it, customers with the link saved. Turning the
 * platform on should not ask its owner to re-enter any of that into a form, and
 * must not, even once, be capable of seeding over it.
 *
 * So when `MM_DEFAULT_TENANT` names a slug that has no row yet, that shop is
 * registered against the deployment's *own* database and adopted exactly as an
 * externally-attached one is: schema and migrations applied (both idempotent),
 * nothing seeded, no password minted, no setting touched. `TenantService.create`
 * decides that by counting the users it finds, not by a flag passed in here —
 * which is what makes it safe to run this on every cold start.
 */
import config from '../config/index.js';
import { platformDb } from './db.js';
import tenantService from './TenantService.js';
import { getDb } from '../infrastructure/database/connection.js';
import { MODULES } from '../shared/permissions.js';

/** Cached so the many cold starts of a serverless deployment do this once each. */
let bootstrap = null;

async function shopName() {
  // The tenant's display name is only a label in the console, so a database
  // that cannot answer is not worth failing a boot over.
  try {
    const db = getDb();
    const en = await db.prepare("SELECT value FROM settings WHERE key = 'company.name'").get();
    const ar = await db.prepare("SELECT value FROM settings WHERE key = 'company.name_ar'").get();
    return { en: en?.value || null, ar: ar?.value || null };
  } catch {
    return { en: null, ar: null };
  }
}

async function register(slug) {
  const existing = await platformDb().prepare('SELECT id FROM tenants WHERE slug = ?').get(slug);
  if (existing) return { slug, alreadyRegistered: true };

  // Only a hosted database can be adopted this way. A shop PC's file is
  // adopted with `scripts/tenant-import.js`, which copies rather than shares,
  // because there the same file would otherwise be open twice for writing.
  if (config.database.driver !== 'libsql') {
    console.warn(
      `MM_DEFAULT_TENANT is "${slug}" but this deployment's database is a local file — `
      + 'register it with `node scripts/tenant-import.js` instead.',
    );
    return null;
  }

  const name = await shopName();
  const result = await tenantService.create({
    slug,
    nameEn: name.en || slug,
    nameAr: name.ar || name.en || slug,
    // The shop that was here first loses nothing: every module, no limits.
    modules: Object.keys(MODULES),
    limits: { maxUsers: 0, maxProducts: 0 },
    websiteEnabled: true,
    database: {
      mode: 'libsql',
      url: config.database.url,
      authToken: config.database.authToken,
    },
  });

  if (result.adopted) {
    console.log(`✔ Adopted the existing shop as "${slug}" — ${result.users} user(s), ${result.products} product(s), nothing reseeded.`);
  } else {
    console.log(`✔ Registered "${slug}" against this deployment's database.`);
  }
  return result;
}

/**
 * Idempotent and safe to call on every request path. Never throws into the
 * request: a fleet register that cannot record the default tenant is a problem
 * for the console, not a reason for the shop's till to stop working.
 */
export async function ensureDefaultTenant() {
  if (!config.platform.enabled || !config.platform.defaultTenant) return null;
  if (bootstrap) return bootstrap;

  bootstrap = register(config.platform.defaultTenant).catch((error) => {
    // A conflict means another cold start won the race — exactly the outcome
    // wanted, so it is not worth retrying or reporting.
    if (error?.code !== 'CONFLICT') {
      console.warn(`Could not register the default tenant: ${error.message}`);
      bootstrap = null;
    }
    return null;
  });
  return bootstrap;
}

export default { ensureDefaultTenant };
