/**
 * Hosted driver, built on libSQL (Turso).
 *
 * Serverless platforms give a function no durable disk, so the local-file
 * driver cannot be used there — Vercel says so outright. libSQL is SQLite
 * spoken over the network, which is why every statement, view and trigger in
 * `schema.sql` is reused byte-for-byte: only the transport changes.
 *
 * The package is imported dynamically so a shop PC running on the file driver
 * never needs it installed.
 */
import fs from 'node:fs';
import { normaliseParams, normaliseRow } from './values.js';

/** libSQL wants `{ sql, args }`; args may be positional or named. */
const toStatement = (sql, params) => ({ sql, args: normaliseParams(params) });

function wrap(runner) {
  return {
    async get(sql, params) {
      const result = await runner.execute(toStatement(sql, params));
      return result.rows.length ? normaliseRow(result.rows[0]) : null;
    },
    async all(sql, params) {
      const result = await runner.execute(toStatement(sql, params));
      return result.rows.map(normaliseRow);
    },
    async run(sql, params) {
      const result = await runner.execute(toStatement(sql, params));
      return {
        lastInsertRowid: Number(result.lastInsertRowid ?? 0),
        changes: Number(result.rowsAffected ?? 0),
      };
    },
  };
}

/**
 * `@libsql/client/web` is the pure-JavaScript build: it speaks HTTP and loads no
 * native binary, which is what a serverless bundle wants. The full build is only
 * reached for `file:` URLs, which exist so the hosted code path can be tested
 * locally without a Turso account.
 */
async function loadClientFactory(url) {
  const entryPoints = url.startsWith('file:')
    ? ['@libsql/client', '@libsql/client/web']
    : ['@libsql/client/web', '@libsql/client'];

  for (const entry of entryPoints) {
    try {
      const module = await import(entry);
      if (module.createClient) return module.createClient;
    } catch {
      // Try the next entry point before giving up.
    }
  }
  throw new Error(
    'The hosted database driver needs @libsql/client. Run `npm install @libsql/client`, '
    + 'or unset TURSO_DATABASE_URL to run on the local file instead.',
  );
}

export async function createLibsqlDriver({ url, authToken }) {
  if (!url) {
    throw new Error('The hosted database driver requires TURSO_DATABASE_URL (or MM_DB_URL).');
  }
  const createClient = await loadClientFactory(url);

  // intMode 'number' keeps IDs as plain numbers, matching the file driver.
  const client = createClient({ url, authToken, intMode: 'number' });

  return {
    name: 'libsql',
    /** No local file exists to VACUUM INTO — backups are SQL exports instead. */
    supportsFileBackup: false,
    executor: wrap(client),

    async exec(sql) {
      await client.executeMultiple(sql);
    },

    async applySchema(schemaFile) {
      await client.executeMultiple(fs.readFileSync(schemaFile, 'utf8'));
    },

    /**
     * An interactive transaction holds a server-side stream, so statements
     * inside it must be routed to the transaction rather than the client. The
     * connection module keeps that routing in async-local storage.
     */
    async begin() {
      const tx = await client.transaction('write');
      const executor = wrap(tx);
      executor.__handle = tx;
      return executor;
    },
    async commit(executor) {
      await executor.__handle.commit();
    },
    async rollback(executor) {
      await executor.__handle.rollback();
    },

    async backupTo() {
      throw new Error('FILE_BACKUP_UNSUPPORTED');
    },

    async close() {
      client.close();
    },
  };
}

export default createLibsqlDriver;
