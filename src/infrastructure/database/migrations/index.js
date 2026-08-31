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
import { getDb, transaction, driverName } from '../connection.js';
import { forgetAllIdentities } from '../../../api/middleware/identity.js';
import migration001 from './001-web-storefront.js';
import migration002 from './002-web-orders.js';
import migration003 from './003-web-order-sequence.js';
import migration004 from './004-order-lifecycle.js';
import migration005 from './005-website-settings.js';
import migration006 from './006-banner-and-shipping.js';
import migration007 from './007-barcode-symbology.js';
import migration008 from './008-shop-branding.js';
import migration009 from './009-search-indexes.js';
import migration010 from './010-request-replay.js';
import migration011 from './011-supplier-payments.js';
import migration012 from './012-costs-and-payroll.js';
import migration013 from './013-shop-install-id.js';
import migration014 from './014-fleet-summary-indexes.js';
import migration015 from './015-legacy-invoices.js';
import migration016 from './016-lifetime-report-indexes.js';
import migration017 from './017-shop-data-export.js';
import migration018 from './018-po-discount-percent.js';
import migration019 from './019-recycle-bin.js';
import migration020 from './020-wastage-and-trash-permissions.js';
import migration021 from './021-return-reversal.js';
import migration022 from './022-gender-and-offers.js';
import migration023 from './023-exchanges.js';
import migration024 from './024-purchase-returns.js';
import migration025 from './025-purchase-replacement-item.js';
import migration026 from './026-website-template.js';
import migration027 from './027-product-search.js';
import migration028 from './028-banner-second-button-and-stats.js';
import migration029 from './029-stats-on-for-real-catalogues.js';
import migration030 from './030-recurring-cost-frequency.js';

/** Ordered. Append only. */
const MIGRATIONS = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
  migration008,
  migration009,
  migration010,
  migration011,
  migration012,
  migration013,
  migration014,
  migration015,
  migration016,
  migration017,
  migration018,
  migration019,
  migration020,
  migration021,
  migration022,
  migration023,
  migration024,
  migration025,
  migration026,
  migration027,
  migration028,
  migration029,
  migration030,
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

/**
 * Collect query-planner statistics — best effort, and ONLY where they are legal.
 *
 * `ANALYZE` is not a schema change. It writes `sqlite_stat1`, which is how the
 * planner learns that `status = 'completed'` matches nearly every row and so
 * stops preferring `idx_sales_status` over a partial index that would actually
 * seek. Skipping it costs milliseconds; it can never cost correctness.
 *
 * Turso does not allow it. libSQL's server refuses the statement outright —
 * `SQL_PARSE_ERROR: SQL not allowed statement: ANALYZE` — and because a
 * migration runs inside a transaction, that refusal aborted the migration, the
 * migration aborted `runMigrations`, and `runMigrations` runs on the first
 * request of every cold serverless instance. So one optimisation hint that the
 * host would not accept took down the ERP, the storefront and the console at
 * once, with every route answering 500. That is the whole reason this helper
 * exists: an optimisation must fail like an optimisation.
 *
 * Two guards, deliberately both:
 *  - the driver is asked first, so on a hosted database the statement is never
 *    sent — catching it afterwards would be too late, since a statement that
 *    errors inside an open libSQL transaction poisons the rest of it;
 *  - and it is wrapped anyway, because a future host may refuse something this
 *    file cannot predict, and the answer must still be "carry on".
 *
 * `PRAGMA optimize` on the hourly sweep (see `platform/FleetSummaryService.js`)
 * is the same statement wearing different clothes and gets the same treatment.
 */
export async function analyze() {
  if (driverName() !== 'sqlite') return false;
  try {
    await getDb().prepare('ANALYZE').run();
    return true;
  } catch {
    // Statistics are a hint. A database that will not gather them is slower,
    // never wrong, and must not stop a shop opening.
    return false;
  }
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
      await migration.up({
        getDb, hasColumn, addColumn, hasTable, ddl, analyze,
      });
      await getDb().prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(migration.name);
    });
    ran.push(migration.name);
  }
  /*
   * A migration can hand a role a permission it did not have a second ago -
   * that is exactly what 017 and 023 do, and on the fleet they run lazily, on a
   * tenant's first request after a deploy. Anything remembered about who may do
   * what is therefore out of date the moment one runs.
   */
  if (ran.length) forgetAllIdentities();
  return ran;
}

export default { runMigrations, hasColumn, addColumn, hasTable, analyze };
