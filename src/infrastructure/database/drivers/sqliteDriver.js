/**
 * Local-file driver, built on Node's own `node:sqlite`.
 *
 * This is the driver the shop runs on. It needs no network, no account and no
 * compiler — the database is one file on the counter PC, which is the whole
 * point of an offline-first ERP. The calls underneath are synchronous; they are
 * presented as promises so the layers above can be written once and run against
 * either driver.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { normaliseParams, normaliseRow } from './values.js';

export function createSqliteDriver({ file }) {
  const db = new DatabaseSync(file);

  // Durability over speed: a power cut at the shop must not lose a paid sale.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  const statements = new Map();
  const compile = (sql) => {
    let statement = statements.get(sql);
    if (!statement) {
      statement = db.prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  };

  const bind = (sql, params) => {
    const statement = compile(sql);
    const args = normaliseParams(params);
    return { statement, args: Array.isArray(args) ? args : [args] };
  };

  const executor = {
    async get(sql, params) {
      const { statement, args } = bind(sql, params);
      return normaliseRow(statement.get(...args));
    },
    async all(sql, params) {
      const { statement, args } = bind(sql, params);
      return statement.all(...args).map(normaliseRow);
    },
    async run(sql, params) {
      const { statement, args } = bind(sql, params);
      const info = statement.run(...args);
      return {
        lastInsertRowid: Number(info.lastInsertRowid ?? 0),
        changes: Number(info.changes ?? 0),
      };
    },
  };

  return {
    name: 'sqlite',
    supportsFileBackup: true,
    /**
     * One shared connection means `BEGIN` cannot be issued twice, so overlapping
     * async callers must be queued. The networked driver opens a stream per
     * transaction and does not need this.
     */
    serialisesTransactions: true,
    executor,

    async exec(sql) {
      db.exec(sql);
    },

    async applySchema(schemaFile) {
      db.exec(fs.readFileSync(schemaFile, 'utf8'));
    },

    async begin() {
      db.exec('BEGIN');
      return executor;
    },
    async commit() {
      db.exec('COMMIT');
    },
    async rollback() {
      db.exec('ROLLBACK');
    },

    /** `VACUUM INTO` is a consistent copy, safe to take while the shop trades. */
    async backupTo(targetPath) {
      db.exec(`VACUUM INTO '${String(targetPath).replace(/'/g, "''")}'`);
      return targetPath;
    },

    async close() {
      statements.clear();
      db.close();
    },
  };
}

export default createSqliteDriver;
