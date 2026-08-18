/**
 * The database boundary for the whole application.
 *
 * Two drivers sit behind one API:
 *
 *   sqlite  — Node's built-in `node:sqlite` against a local file. The shop
 *             counter runs on this: no network, no account, no compiler.
 *   libsql  — SQLite spoken over the network (Turso). Required on serverless
 *             hosts, which give a function no durable disk.
 *
 * The schema is shared byte-for-byte because libSQL *is* SQLite. Only the
 * transport differs, so nothing above this file knows which driver is live.
 *
 * Everything here is async. That is not decoration: a network database cannot
 * be synchronous, so the layers above are written once, in the shape that works
 * for both.
 *
 * ── Multi-tenancy ────────────────────────────────────────────────────────────
 * A connection is an object, not a set of module globals, because a platform
 * serves many shops from one process and each shop has its own database. The
 * active one lives in AsyncLocalStorage for the life of a request, so the ~210
 * places that call `getDb()` never had to learn about tenants.
 *
 * With no tenant context — the shop PC, the scripts, the tests — `getDb()`
 * returns the process default and behaves exactly as it always has.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../../config/index.js';
import { SCHEMA_SQL } from './schema.js';
import { tenantStore } from './connections.js';

/** The process-wide database: single-tenant installs and every CLI script. */
let defaultConnection = null;

/**
 * Build a connection: a driver, its facade, its own transaction store and its
 * own write queue. Everything a database needs to be used independently of any
 * other database open in the same process.
 */
function createConnection(driver) {
  const txStore = new AsyncLocalStorage();

  /**
   * With one shared connection, `BEGIN` cannot be issued twice. Synchronous code
   * got that for free; async code does not, so overlapping requests are queued
   * into a single file of writers. Networked drivers open a stream per
   * transaction and need no such queue.
   */
  let writeQueue = Promise.resolve();

  const activeExecutor = () => txStore.getStore()?.executor || driver.executor;

  const facade = {
    /** Mirrors the `prepare(sql).get(...)` shape the repositories already use. */
    prepare(sql) {
      return {
        get: (...params) => activeExecutor().get(sql, params),
        all: (...params) => activeExecutor().all(sql, params),
        run: (...params) => activeExecutor().run(sql, params),
      };
    },
    /**
     * Multi-statement DDL. Deliberately refuses to run inside a transaction:
     * the driver's `exec` goes straight to the connection, not to the open
     * transaction, so calling it mid-transaction takes a second write lock on
     * the same database and deadlocks with SQLITE_BUSY. That failure is silent
     * and slow to diagnose, so it is turned into an explanatory error instead.
     */
    exec(sql) {
      if (txStore.getStore()) {
        throw new Error(
          'getDb().exec() cannot run inside a transaction — it bypasses the open '
          + 'transaction and deadlocks. Use getDb().prepare(sql).run() per statement.',
        );
      }
      return driver.exec(sql);
    },
    get driverName() {
      return driver.name;
    },
    get supportsFileBackup() {
      return driver.supportsFileBackup;
    },
  };

  async function transaction(fn) {
    const outer = txStore.getStore();
    if (outer) {
      outer.depth += 1;
      try {
        return await fn(facade);
      } finally {
        outer.depth -= 1;
      }
    }

    const run = async () => {
      const executor = await driver.begin();
      const state = { executor, depth: 1 };
      return txStore.run(state, async () => {
        try {
          const result = await fn(facade);
          await driver.commit(executor);
          return result;
        } catch (error) {
          try {
            await driver.rollback(executor);
          } catch {
            // A failed rollback must never mask the error that caused it.
          }
          throw error;
        }
      });
    };

    if (!driver.serialisesTransactions) return run();

    // Queue, but never let one caller's failure break the chain for the next.
    const queued = writeQueue.then(run, run);
    writeQueue = queued.catch(() => {});
    return queued;
  }

  return {
    driver,
    facade,
    transaction,
    inTransaction: () => Boolean(txStore.getStore()),
    applySchema: () => driver.applySchema(SCHEMA_SQL),
    backupTo: (target) => driver.backupTo(target),
    close: () => driver.close(),
  };
}

/**
 * Open a driver for an arbitrary database. Used for tenants and for the control
 * plane; `initDb()` below is the single-tenant special case of it.
 */
export async function openDriver({ driver: kind, url, authToken, file }) {
  // Each driver is loaded only if selected: a hosted deployment should never
  // pull in `node:sqlite`, and a shop PC should never need the network client.
  if (kind === 'libsql') {
    const { createLibsqlDriver } = await import('./drivers/libsqlDriver.js');
    return createLibsqlDriver({ url, authToken });
  }
  const { createSqliteDriver } = await import('./drivers/sqliteDriver.js');
  return createSqliteDriver({ file });
}

/** A connection for one tenant, ready to be cached and reused. */
export async function openConnection(descriptor) {
  return createConnection(await openDriver(descriptor));
}

/**
 * Open the process default. Call once during startup, before anything touches
 * `getDb`. Idempotent, so scripts and tests can call it freely.
 */
export async function initDb() {
  if (defaultConnection) return defaultConnection.facade;
  defaultConnection = await openConnection({
    driver: config.database.driver,
    url: config.database.url,
    authToken: config.database.authToken,
    file: config.paths.database,
  });
  return defaultConnection.facade;
}

/** The connection this request belongs to: its tenant's, or the process default. */
function current() {
  const scoped = tenantStore.getStore()?.connection;
  if (scoped) return scoped;
  if (!defaultConnection) {
    throw new Error('Database not initialised — call await initDb() during startup.');
  }
  return defaultConnection;
}

/** Run `fn` with `tenant`'s database as the one `getDb()` returns. */
export function runWithTenant(tenant, connection, fn) {
  return tenantStore.run({ tenant, connection }, fn);
}

/** The tenant serving this request, or null in single-tenant mode. */
export const currentTenant = () => tenantStore.getStore()?.tenant || null;

/** Synchronous accessor — deliberately, so call sites stay `getDb().prepare(…)`. */
export function getDb() {
  return current().facade;
}

export function driverName() {
  const scoped = tenantStore.getStore()?.connection;
  if (scoped) return scoped.driver.name;
  return defaultConnection ? defaultConnection.driver.name : config.database.driver;
}

export function supportsFileBackup() {
  const scoped = tenantStore.getStore()?.connection;
  if (scoped) return scoped.driver.supportsFileBackup;
  return defaultConnection
    ? defaultConnection.driver.supportsFileBackup
    : config.database.driver === 'sqlite';
}

export async function applySchema() {
  await initDb();
  return current().applySchema();
}

/**
 * Run `fn` inside a transaction on the current database. Nested calls join the
 * outer one, so services compose: a sale posts stock movements, redeems a
 * promotion and writes an audit row as a single atomic unit, and only the
 * outermost call commits.
 */
export const transaction = (fn) => current().transaction(fn);

export const inTransaction = () => current().inTransaction();

/**
 * Consistent copy of the database. Only meaningful for the file driver; hosted
 * databases are backed up by the provider, and the caller is expected to check
 * `supportsFileBackup()` first rather than catch an error.
 */
export const backupTo = (targetPath) => current().backupTo(targetPath);

export async function closeDb() {
  if (!defaultConnection) return;
  await defaultConnection.close();
  defaultConnection = null;
}

export default {
  initDb, getDb, driverName, supportsFileBackup, applySchema,
  transaction, inTransaction, backupTo, closeDb,
  openConnection, runWithTenant, currentTenant,
};
