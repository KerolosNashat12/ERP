/**
 * One connection per tenant, resolved per request.
 *
 * The single-shop build opens one database for the life of the process. A
 * platform cannot: every request belongs to a different shop, and each shop has
 * its own database — separate files on Turso, not rows sharing a `tenant_id`
 * column. That choice is deliberate. With a shared table, one forgotten
 * `WHERE tenant_id = ?` in any of ~210 query sites puts one shop's sales on
 * another shop's screen, and no amount of care makes that impossible. With
 * separate databases it is not a mistake anyone can make.
 *
 * The awkward part would normally be that `getDb()` is called from 210 places
 * with no idea which tenant it serves. Rather than thread a handle through every
 * layer, the active tenant's connection lives in AsyncLocalStorage for the
 * duration of the request — the same mechanism the transaction router already
 * uses. Call sites stay exactly as they are.
 *
 * Single-tenant mode is untouched: with no tenant context, `getDb()` returns the
 * process-wide default, which is what the shop counter runs on, offline, forever.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** Holds `{ tenant, connection }` for the duration of one request. */
export const tenantStore = new AsyncLocalStorage();

/**
 * Connections are expensive to make and cheap to keep, but a platform with a
 * hundred shops must not hold a hundred sockets open forever on a serverless
 * instance that handles three of them. Least-recently-used eviction keeps the
 * busy shops warm and lets the quiet ones go.
 */
const MAX_OPEN = Number(process.env.MM_MAX_TENANT_CONNECTIONS || 25);

const cache = new Map();

/**
 * How many tenant connections this instance has opened since it started.
 *
 * Not a statistic for its own sake: on a metered database a connection is a
 * unit of cost, and "how many databases does one page load open" was the whole
 * question behind reading the fleet overview from a summary table instead of
 * computing it. It is reported by `/api/health` so the answer can be measured
 * from outside rather than argued about — count it before a page load, count it
 * after, and the difference is what that page cost.
 *
 * A counter rather than a gauge: `openCount()` below says how many are open
 * right now, which LRU eviction keeps small and which therefore cannot show the
 * churn. This only ever goes up.
 */
let openedTotal = 0;
export const totalOpened = () => openedTotal;

/** Marks a key as most recently used by reinserting it — Map keeps insertion order. */
function touch(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

async function evictIfNeeded() {
  while (cache.size > MAX_OPEN) {
    const [oldestKey, oldest] = cache.entries().next().value;
    cache.delete(oldestKey);
    try {
      await oldest.close();
    } catch {
      // A connection that will not close cleanly is still gone from the cache;
      // holding the whole platform up for it would be worse.
    }
  }
}

/**
 * Get (or open) the connection for a tenant.
 *
 * @param {string} key     stable cache key, normally the tenant slug
 * @param {Function} open  async factory returning a connection object
 */
export async function connectionFor(key, open) {
  const existing = touch(key);
  if (existing) return existing.promise ? existing.promise : existing;

  // The promise is cached, not just the result: two concurrent first requests
  // for the same tenant must share one connection attempt, not race to open two.
  openedTotal += 1;
  const pending = {
    promise: open().then((connection) => {
      cache.set(key, connection);
      return connection;
    }).catch((error) => {
      cache.delete(key);
      throw error;
    }),
    close: async () => {},
  };
  cache.set(key, pending);

  const connection = await pending.promise;
  await evictIfNeeded();
  return connection;
}

/** Drop a tenant's connection — after suspending it, or changing its credentials. */
export async function forget(key) {
  const entry = cache.get(key);
  if (!entry) return;
  cache.delete(key);
  try {
    await entry.close?.();
  } catch { /* see evictIfNeeded */ }
}

export async function closeAll() {
  const entries = [...cache.values()];
  cache.clear();
  await Promise.allSettled(entries.map((e) => e.close?.()));
}

export const openCount = () => cache.size;

export default {
  tenantStore, connectionFor, forget, closeAll, openCount, totalOpened,
};
