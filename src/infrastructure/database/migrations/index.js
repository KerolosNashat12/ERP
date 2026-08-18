/**
 * Schema migrations.
 *
 * `schema.js` describes the shape a NEW database should have, and is applied on
 * every start — which covers new tables, indexes and views, because those are
 * all `CREATE … IF NOT EXISTS`. What it cannot do is change a table that already
 * exists: adding a column to `products` on a database that is already live needs
 * an `ALTER TABLE`, and running that twice is an error.
 *
 * So: every structural change gets a migration here as well as its place in
 * `schema.js`. The pair is deliberate — `schema.js` stays readable as the
 * current shape, and migrations carry existing databases to it. Each runs once,
 * in order, recorded in `schema_migrations`.
 *
 * Rules for writing one:
 *  - Give it the next number and never renumber an existing file.
 *  - Make it idempotent anyway (the helpers below check before acting), because
 *    a database restored from an old backup can be in an unexpected state.
 *  - Keep it small enough to read in one screen.
 */
import { getDb, transaction } from '../connection.js';
import migration001 from './001-web-storefront.js';
import migration002 from './002-web-orders.js';
import migration003 from './003-web-order-sequence.js';

/** Ordered. Append only. */
const MIGRATIONS = [
  migration001,
  migration002,
  migration003,
];

async function ensureRegistry() {
  await getDb().exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
}

async function applied() {
  const rows = await getDb().prepare('SELECT name FROM schema_migrations').all();
  return new Set(rows.map((r) => r.name));
}

/** True when `table` already has `column` — the guard every ALTER needs. */
export async function hasColumn(table, column) {
  const rows = await getDb().prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}

/** Adds a column only if it is missing. `definition` excludes the column name. */
export async function addColumn(table, column, definition) {
  if (await hasColumn(table, column)) return false;
  // prepare().run() rather than exec(): migrations run inside a transaction,
  // and exec() would open a second writer against the same database.
  await getDb().prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  return true;
}

/** Single DDL statement, transaction-safe. Use one call per statement. */
export async function ddl(sql) {
  await getDb().prepare(sql).run();
}

export async function hasTable(table) {
  const row = await getDb()
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table);
  return Boolean(row);
}

/**
 * Run everything not yet applied. Safe to call on every start; returns the
 * names that actually ran so the caller can log something meaningful.
 */
export async function runMigrations() {
  await ensureRegistry();
  const done = await applied();
  const ran = [];

  for (const migration of MIGRATIONS) {
    if (done.has(migration.name)) continue;

    // Each migration is atomic on its own: a failure half way through leaves
    // the database untouched and unrecorded, so the next start retries it.
    await transaction(async () => {
      await migration.up({ getDb, hasColumn, addColumn, hasTable, ddl });
      await getDb().prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(migration.name);
    });
    ran.push(migration.name);
  }
  return ran;
}

export default { runMigrations, hasColumn, addColumn, hasTable };
