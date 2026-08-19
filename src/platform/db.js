/**
 * The control-plane database — its own connection, opened once.
 *
 * This is deliberately NOT wired into `tenantStore` / `getDb()`. A tenant
 * request that forgets to scope itself can, at worst, fall back to the
 * process-default single-shop database (see `connection.js`'s `current()`)
 * — it can never reach this one, because nothing anywhere puts this
 * connection where `getDb()` looks. Platform code reaches it only through
 * `platformDb()`, exported from this file and nowhere else.
 *
 * The shape mirrors `createConnection()` in `infrastructure/database/
 * connection.js` (a facade over prepared statements, plus a serialised
 * transaction helper) but is not that function: that one is hard-wired to
 * the ERP's own `SCHEMA_SQL`, and this database has a different schema.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import bcrypt from 'bcryptjs';
import config from '../config/index.js';
import { openDriver } from '../infrastructure/database/connection.js';
import { PLATFORM_SCHEMA_SQL } from './schema.js';

/** The single control-plane connection for the life of the process. */
let connection = null;

function buildConnection(driver) {
  const txStore = new AsyncLocalStorage();
  // The sqlite driver serialises writes (one shared connection, no BEGIN
  // twice) — same reasoning as the tenant/default connection.
  let writeQueue = Promise.resolve();
  const activeExecutor = () => txStore.getStore()?.executor || driver.executor;

  const facade = {
    prepare(sql) {
      return {
        get: (...params) => activeExecutor().get(sql, params),
        all: (...params) => activeExecutor().all(sql, params),
        run: (...params) => activeExecutor().run(sql, params),
      };
    },
    exec: (sql) => driver.exec(sql),
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
    const queued = writeQueue.then(run, run);
    writeQueue = queued.catch(() => {});
    return queued;
  }

  return {
    driver, facade, transaction, close: () => driver.close(),
  };
}

/**
 * A password nobody chose and nobody but this process ever saw in the clear.
 * Printed once at startup; only its bcrypt hash is written to disk.
 */
function generateOwnerPassword() {
  return crypto.randomBytes(15).toString('base64url');
}

/**
 * The owner account is created by whoever opens the console first, on the
 * console itself — see `POST /api/platform/auth/setup`. Nothing is seeded here,
 * because the two ways of doing it automatically are both bad: a fixed default
 * password is a published one, and a generated password printed to stdout is
 * invisible on a host whose logs nobody is watching.
 *
 * `MM_PLATFORM_OWNER_PASSWORD` stays as the way to set it without a browser —
 * useful for a scripted install, and what the tests use.
 */
async function seedOwnerIfEmpty() {
  const db = connection.facade;
  const existing = await db.prepare('SELECT id FROM platform_users LIMIT 1').get();
  if (existing) return;

  const chosen = String(process.env.MM_PLATFORM_OWNER_PASSWORD || '').trim();
  if (!chosen) return;
  if (chosen.length < 8) {
    throw new Error('MM_PLATFORM_OWNER_PASSWORD must be at least 8 characters');
  }
  const password = chosen;
  const hash = bcrypt.hashSync(password, config.auth.bcryptRounds);
  await db.prepare(`
    INSERT INTO platform_users (username, password_hash, full_name, is_active, created_at)
    VALUES ('owner', ?, 'Platform Owner', 1, ?)
  `).run(hash, new Date().toISOString());

  console.log('');
  console.log('  Platform owner account created as "owner", with the password');
  console.log('  from MM_PLATFORM_OWNER_PASSWORD. Only its hash is stored.');
  console.log('');
}

/**
 * The control plane's own descriptor: a libSQL database when
 * MM_PLATFORM_DB_URL is set, the local file otherwise.
 *
 * Only the file branch touches the disk. A hosted deployment's filesystem is
 * read-only outside a scratch directory, so creating a directory for a database
 * that will never live there is both pointless and a way to fail at boot.
 */
function controlPlaneDescriptor() {
  if (config.platform.driver === 'libsql') {
    return { driver: 'libsql', url: config.platform.url, authToken: config.platform.authToken };
  }
  fs.mkdirSync(path.dirname(config.platform.databaseFile), { recursive: true });
  return { driver: 'sqlite', file: config.platform.databaseFile };
}

/**
 * Idempotent — safe to call from every request path and every script.
 *
 * The schema is applied the same way on both drivers: `PLATFORM_SCHEMA_SQL` is
 * entirely `CREATE … IF NOT EXISTS`, so re-applying it on every start is what
 * makes a deploy that adds a table actually work, and costs one round trip.
 */
export async function initPlatformDb() {
  if (connection) return connection.facade;
  const driver = await openDriver(controlPlaneDescriptor());
  connection = buildConnection(driver);
  await driver.applySchema(PLATFORM_SCHEMA_SQL);
  await seedOwnerIfEmpty();
  return connection.facade;
}

/** The only way to reach the control plane. Never exposed through getDb(). */
export function platformDb() {
  if (!connection) {
    throw new Error('Platform database not initialised — call await initPlatformDb() first.');
  }
  return connection.facade;
}

export function platformTransaction(fn) {
  if (!connection) {
    throw new Error('Platform database not initialised — call await initPlatformDb() first.');
  }
  return connection.transaction(fn);
}

export async function closePlatformDb() {
  if (!connection) return;
  await connection.close();
  connection = null;
}

export default {
  initPlatformDb, platformDb, platformTransaction, closePlatformDb,
};
