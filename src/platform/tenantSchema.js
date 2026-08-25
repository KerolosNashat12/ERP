/**
 * Every shop's database is brought up to date the first time this process
 * touches it.
 *
 * ── The failure this exists to prevent ───────────────────────────────────────
 * A migration adds a column. The single-shop build gets it on the next start,
 * because `start()` runs the migrations before it listens. A PLATFORM does not:
 * each shop is a separate database, the fleet is migrated by an operator
 * pressing a button in the console, and until somebody presses it every shop is
 * running last week's schema against this week's code.
 *
 * That is not a theoretical gap. Migration 018 added `purchase_orders
 * .discount_percent`; the code that writes a purchase order started sending it;
 * and the next shop to raise one — a NEW shop, created before the deploy, never
 * migrated — got:
 *
 *     table purchase_orders has no column named discount_percent
 *
 * as a bare 500 on the save button. The shop could not buy anything, and
 * nothing on the screen could have told its owner why. The console's fleet
 * migration was the fix and nobody knew to run it.
 *
 * ── What this does ───────────────────────────────────────────────────────────
 * The first request a process serves for a shop runs that shop's migrations,
 * exactly as a single-shop start would. Once per slug per process: after that
 * it is one Set lookup, and a serverless instance that serves one shop pays for
 * one shop.
 *
 * ── Why a failure here is not fatal ──────────────────────────────────────────
 * Because this code runs on the request path, and the last time a migration ran
 * on the request path and threw, one refused statement took every route on
 * three surfaces down with a 500 (see `analyze()` in migrations/index.js). A
 * migration that cannot be applied leaves the shop exactly where it was — which
 * is where every shop was before this file existed — and says so in the log
 * rather than turning one bad migration into an outage. The console's fleet
 * migration remains the deliberate, visible, reportable path; this is the
 * safety net under it.
 */
import { runWithTenant } from '../infrastructure/database/connection.js';
import { runMigrations } from '../infrastructure/database/migrations/index.js';

/**
 * Shops this process has already brought up to date.
 *
 * A Set of slugs, not a cache with a TTL: the schema of a database this process
 * has migrated cannot go backwards underneath it, and a new deployment is a new
 * process with an empty Set — which is exactly when the check needs to run
 * again.
 */
const checked = new Set();

/** In-flight checks, so twenty parallel requests for one shop migrate it once. */
const running = new Map();

export function forgetSchema(slug) {
  checked.delete(slug);
  running.delete(slug);
}

/** For tests: pretend this process has just started. */
export function resetSchemaMemory() {
  checked.clear();
  running.clear();
}

export async function ensureMigrated(slug, connection) {
  if (checked.has(slug)) return false;
  if (running.has(slug)) return running.get(slug);

  const attempt = (async () => {
    try {
      const applied = await runWithTenant({ slug }, connection, () => runMigrations());
      if (applied.length) {
        console.log(`Applied ${applied.length} migration(s) to "${slug}": ${applied.join(', ')}`);
      }
      checked.add(slug);
      return applied.length > 0;
    } catch (error) {
      // Deliberately not rethrown — see the header. The shop carries on with
      // the schema it had, and the next request tries again.
      console.warn(`Could not bring "${slug}" up to date: ${error.message}`);
      return false;
    } finally {
      running.delete(slug);
    }
  })();

  running.set(slug, attempt);
  return attempt;
}

export default { ensureMigrated, forgetSchema, resetSchemaMemory };
