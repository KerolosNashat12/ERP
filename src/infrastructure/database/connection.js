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
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../../config/index.js';
import { SCHEMA_SQL } from './schema.js';

let driver = null;
let facade = null;
const txStore = new AsyncLocalStorage();

/**
 * With one shared connection, `BEGIN` cannot be issued twice. Synchronous code
 * got that for free; async code does not, so overlapping requests are queued
 * into a single file of writers. Networked drivers open a stream per
 * transaction and need no such queue.
 */
let writeQueue = Promise.resolve();

const activeExecutor = () => txStore.getStore()?.executor || driver.executor;

/** Mirrors the `prepare(sql).get(...)` shape the repositories already use. */
function buildFacade() {
  return {
    prepare(sql) {
      return {
        get: (...params) => activeExecutor().get(sql, params),
        all: (...params) => activeExecutor().all(sql, params),
        run: (...params) => activeExecutor().run(sql, params),
      };
    },
    exec: (sql) => driver.exec(sql),
    get driverName() {
      return driver.name;
    },
    get supportsFileBackup() {
      return driver.supportsFileBackup;
    },
  };
}

/**
 * Open the database. Call once during startup, before anything touches `getDb`.
 * Idempotent, so scripts and tests can call it freely.
 */
export async function initDb() {
  if (driver) return facade;

  // Each driver is loaded only if selected: a hosted deployment should never
  // pull in `node:sqlite`, and a shop PC should never need the network client.
  if (config.database.driver === 'libsql') {
    const { createLibsqlDriver } = await import('./drivers/libsqlDriver.js');
    driver = await createLibsqlDriver({
      url: config.database.url,
      authToken: config.database.authToken,
    });
  } else {
    const { createSqliteDriver } = await import('./drivers/sqliteDriver.js');
    driver = createSqliteDriver({ file: config.paths.database });
  }

  facade = buildFacade();
  return facade;
}

/** Synchronous accessor — deliberately, so call sites stay `getDb().prepare(…)`. */
export function getDb() {
  if (!facade) {
    throw new Error('Database not initialised — call await initDb() during startup.');
  }
  return facade;
}

export function driverName() {
  return driver ? driver.name : config.database.driver;
}

export function supportsFileBackup() {
  return driver ? driver.supportsFileBackup : config.database.driver === 'sqlite';
}

export async function applySchema() {
  await initDb();
  await driver.applySchema(SCHEMA_SQL);
}

/**
 * Run `fn` inside a transaction. Nested calls join the outer one, so services
 * compose: a sale posts stock movements, redeems a promotion and writes an
 * audit row as a single atomic unit, and only the outermost call commits.
 */
export async function transaction(fn) {
  const outer = txStore.getStore();
  if (outer) {
    outer.depth += 1;
    try {
      return await fn(getDb());
    } finally {
      outer.depth -= 1;
    }
  }

  const run = async () => {
    const executor = await driver.begin();
    const state = { executor, depth: 1 };
    return txStore.run(state, async () => {
      try {
        const result = await fn(getDb());
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

export const inTransaction = () => Boolean(txStore.getStore());

/**
 * Consistent copy of the database. Only meaningful for the file driver; hosted
 * databases are backed up by the provider, and the caller is expected to check
 * `supportsFileBackup()` first rather than catch an error.
 */
export async function backupTo(targetPath) {
  return driver.backupTo(targetPath);
}

export async function closeDb() {
  if (!driver) return;
  await driver.close();
  driver = null;
  facade = null;
}

export default {
  initDb, getDb, driverName, supportsFileBackup, applySchema,
  transaction, inTransaction, backupTo, closeDb,
};
