/**
 * Single SQLite connection for the whole process.
 *
 * Uses Node's BUILT-IN `node:sqlite` module — deliberately, not an npm driver.
 * Native drivers have to be compiled for each Node version, and when no
 * prebuilt binary exists the install fails on any machine without a C++
 * toolchain. For software that gets installed on shop counter PCs by
 * non-developers, that is a real failure mode. With the built-in module the
 * project has zero dependencies that need building.
 *
 * Offline-first notes:
 *  - WAL journal mode keeps reads fast while writes happen.
 *  - `synchronous = FULL` favours durability over raw speed: a power cut at the
 *    shop must not lose a completed sale.
 *  - Foreign keys are enforced so the ledger can never orphan.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../../config/index.js';

let db = null;
let transactionDepth = 0;

export function getDb() {
  if (db) return db;

  db = new DatabaseSync(config.paths.database);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/** Apply the schema. Safe to run repeatedly (everything is IF NOT EXISTS). */
export function applySchema() {
  getDb().exec(fs.readFileSync(config.paths.schema, 'utf8'));
}

/**
 * Run `fn` inside a transaction. Nested calls join the outer transaction, which
 * lets services compose (a sale posts stock movements, redeems a promotion and
 * writes an audit row as one atomic unit). Only the outermost call commits.
 */
export function transaction(fn) {
  const database = getDb();

  if (transactionDepth > 0) {
    transactionDepth += 1;
    try {
      return fn(database);
    } finally {
      transactionDepth -= 1;
    }
  }

  database.exec('BEGIN');
  transactionDepth = 1;
  try {
    const result = fn(database);
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // A rollback failure must not mask the original error.
    }
    throw error;
  } finally {
    transactionDepth = 0;
  }
}

export const inTransaction = () => transactionDepth > 0;

/**
 * Consistent copy of the database, safe to take while the shop is trading.
 * `VACUUM INTO` is plain SQL and needs no driver-specific backup API.
 */
export function backupTo(targetPath) {
  getDb().exec(`VACUUM INTO '${String(targetPath).replace(/'/g, "''")}'`);
  return targetPath;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
    transactionDepth = 0;
  }
}

export default { getDb, applySchema, transaction, inTransaction, backupTo, closeDb };
