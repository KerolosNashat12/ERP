/**
 * Reading a whole shop out of its database, and putting one back.
 *
 * ── Why not a copy of the database file ──────────────────────────────────────
 * `scripts/backup.js` takes `VACUUM INTO`, which is a perfect, consistent copy
 * — and is available on exactly one of the two drivers. A shop on Turso has no
 * file to copy and no filesystem to copy it to, which is why that script says
 * so and exits. Every shop this platform sells is on Turso. So a backup here is
 * read row by row through the same connection everything else uses, which works
 * identically on both drivers and needs no privilege the ERP does not already
 * have.
 *
 * ── Consistency ──────────────────────────────────────────────────────────────
 * A row-by-row read of a live shop is a series of statements, not one instant.
 * A sale rung up between reading `sales` and reading `sale_lines` would produce
 * an invoice with no lines. So the whole read runs inside ONE transaction: on
 * both drivers that is a repeatable snapshot of the database as it was when the
 * transaction opened. SQLite in WAL mode gives a reader a consistent view of the
 * last commit while writers go on appending, and libSQL's interactive
 * transaction does the same server-side.
 *
 * The cost is honest and worth naming, because "nothing here may make a shop's
 * till slower" is a rule: on the FILE driver, `createConnection` serialises
 * transactions through one write queue (one connection cannot `BEGIN` twice),
 * so while a backup's transaction is open, that shop's writes queue behind it.
 * On the hosted driver — which is what every shop on this platform runs —
 * `serialisesTransactions` is false, each transaction is its own stream, and a
 * backup costs a till nothing at all. The file driver is the shop-PC case,
 * where the scheduled job does not run and a backup is something the owner
 * starts deliberately. The size ceiling in `BackupService` bounds how long
 * either can last.
 *
 * ── Memory ───────────────────────────────────────────────────────────────────
 * The function that produces this has a memory limit and a shop's database will
 * grow, so nothing here ever holds a table. Rows are read in keyset-paged
 * batches by rowid, serialised to JSONL, and flushed into the archive as soon
 * as a part reaches its size — so the peak is one part (a few megabytes), not
 * one table and never one shop.
 *
 * ── The row format ───────────────────────────────────────────────────────────
 * JSON Lines: one array per row, values in the order the manifest names the
 * columns. Arrays rather than objects because the column names would otherwise
 * be repeated on every one of a hundred thousand rows, and the file is written
 * once and read once by a machine. The only value that is not a JSON scalar is
 * a BLOB — a product photograph, a storefront banner — which is written as
 * `{"b64": "…"}`. Nothing else in this schema produces an object, so the tag is
 * unambiguous by construction.
 */
import crypto from 'node:crypto';
import { getDb, transaction, driverName } from '../infrastructure/database/connection.js';

/** How many rows are pulled from the database in one statement. */
export const READ_BATCH = Number(process.env.MM_BACKUP_READ_BATCH || 500);

/** How large one JSONL part may grow before it is flushed into the archive. */
export const PART_BYTES = Number(process.env.MM_BACKUP_PART_BYTES || 4 * 1024 * 1024);

/**
 * How many tables one signature statement may cover.
 *
 * The signature was written as a single `UNION ALL` over every table — one
 * round trip whatever the shop's size, which was the point. Forty-four tables
 * is nowhere near SQLite's own ceiling of five hundred compound terms, and the
 * shop PC ran it without blinking. Turso would not:
 *
 *     SQLITE_UNKNOWN: SQLite error: too many terms in compound SELECT
 *
 * The same lesson as `ANALYZE`, learned twice now — the hosted database sets
 * limits the local one does not, and no test against a `file:` database can
 * find them. Eight is far under any plausible ceiling, and `signatureRows`
 * falls back to one table per statement if even that is too many somewhere.
 */
const SIGNATURE_TERMS = Number(process.env.MM_BACKUP_SIGNATURE_TERMS || 8);

/**
 * How many bind parameters one INSERT may carry on the way back in. SQLite's
 * historical limit is 999 and libSQL's is far higher; staying under the lower
 * one means the restore does not have to ask which database it is talking to.
 */
const MAX_BIND_PARAMS = 900;

/**
 * The columns a copy that LEAVES THE BUILDING must not carry.
 *
 * The control plane's own backups are complete, hashes and all, because their
 * only purpose is to be restored and a restore that cannot sign anybody in is
 * not a restore. The copy a shop administrator downloads to his laptop is a
 * different object with a different risk: it is emailed, kept in a Downloads
 * folder, copied to a phone, and a bcrypt hash sitting in it is an offline
 * password-cracking exercise handed to whoever ends up with the file — against
 * passwords that staff reuse elsewhere.
 *
 * So the shop's own copy is EVERYTHING THE SHOP KNOWS EXCEPT ITS CREDENTIALS.
 * Every price, cost, phone number, salary and invoice is there; only the
 * columns below are replaced with `REDACTED`. A snapshot that has been through
 * this says so in its manifest (`redacted`), the README says so in both
 * languages, and `restoreSnapshot` refuses to be silent about it.
 *
 * A map rather than a list so the fence beside it (`shop-data-export.test.js`)
 * can assert that every column in this schema whose name looks like a secret is
 * either in here or deliberately absent.
 */
export const CREDENTIAL_COLUMNS = {
  users: ['password_hash'],
};

/** What a redacted value becomes. A string, because `password_hash` is NOT NULL. */
export const REDACTED = '__REDACTED__';

/**
 * Tables that belong to a driver or to a mechanism, not to the shop.
 *
 * `sqlite_*` is SQLite's own bookkeeping and cannot be written to directly.
 * `libsql_*` and `_litestream_*` are the hosted driver's. `request_replay` is
 * the idempotency ledger from `shared/requestReplay.js`: rows that expire in
 * minutes, describing HTTP requests that finished long before any restore, and
 * restoring them would re-arm claims against keys no client will ever send
 * again.
 */
const SKIP_PREFIXES = ['sqlite_', 'libsql_', '_litestream'];
const SKIP_TABLES = new Set(['request_replay']);

/**
 * Dimension tables first, then everything else alphabetically.
 *
 * Order does not matter for correctness — the restore defers foreign keys — but
 * it matters for the readable workbook, which is built from the same pass and
 * needs `brands` in memory before it meets a product that names one.
 */
const READ_ORDER = [
  'settings', 'sequences', 'roles', 'permissions', 'role_permissions', 'users',
  'warehouses', 'suppliers', 'brands', 'categories', 'attributes', 'attribute_values',
  'cost_categories', 'employees', 'customers', 'products', 'product_variants',
  // The documents, before their own lines: alphabetically `sale_lines` sorts
  // ahead of `sales`, and a line that reaches the workbook before its invoice
  // does has no invoice number to show.
  'promotions', 'sales', 'sales_returns', 'purchase_orders', 'stock_adjustments', 'web_orders',
  // Same reason: `legacy_invoice_payments` sorts alphabetically ahead of the
  // `legacy_invoices` it belongs to, and a payment that reaches the workbook
  // before its invoice has nothing to name it by.
  'legacy_invoices',
];

export function isShopTable(name) {
  if (SKIP_TABLES.has(name)) return false;
  return !SKIP_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Every table in this shop's database, in the order they should be read. */
export async function shopTables() {
  const rows = await getDb().prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all();
  const usable = rows.filter((row) => isShopTable(row.name));
  const rank = (name) => {
    const index = READ_ORDER.indexOf(name);
    return index === -1 ? READ_ORDER.length : index;
  };
  usable.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
  return usable.map((row) => ({
    name: row.name,
    // A WITHOUT ROWID table cannot be paged by rowid. None exist in this schema
    // today; noticing rather than assuming is what keeps that true tomorrow.
    hasRowid: !/WITHOUT\s+ROWID/i.test(String(row.sql || '')),
  }));
}

export async function columnsOf(table) {
  const rows = await getDb().prepare(`PRAGMA table_info(${quoteName(table)})`).all();
  return rows.map((row) => row.name);
}

/** Identifiers come from `sqlite_master`, never from a request — but quote anyway. */
function quoteName(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Refusing to touch a table with an unexpected name: ${name}`);
  }
  return `"${name}"`;
}

/** A BLOB becomes a tagged object; everything else is already JSON. */
export function encodeValue(value) {
  if (value === undefined) return null;
  if (Buffer.isBuffer(value)) return { b64: value.toString('base64') };
  if (ArrayBuffer.isView(value)) return { b64: Buffer.from(value).toString('base64') };
  if (typeof value === 'bigint') return Number(value);
  return value;
}

export function decodeValue(value) {
  if (value && typeof value === 'object' && typeof value.b64 === 'string') {
    return Buffer.from(value.b64, 'base64');
  }
  return value;
}

/**
 * Thrown when the shop was written to WHILE it was being read.
 *
 * Not a failure of the database and not a bug: somebody rang up a sale during
 * the backup. It matters because the archive is read table by table, so a sale
 * that lands between `sales` and `sale_lines` would be stored as an invoice
 * with no lines — and a backup that is quietly wrong is worse than no backup at
 * all, because it is the thing you reach for on the day it has to be right.
 *
 * The caller retries once. A shop busy enough to lose the race twice gets a
 * refusal it can read, not a file it should not trust.
 */
export class SnapshotRaceError extends Error {
  constructor() {
    super('The shop was written to while it was being read, so this copy could be '
      + 'half of one moment and half of another. Nothing was stored. Try again.');
    this.name = 'SnapshotRaceError';
    this.code = 'SNAPSHOT_RACE';
  }
}

/**
 * A cheap signature of everything in this shop that could change under a read.
 *
 * ── Why this exists at all ───────────────────────────────────────────────────
 * The whole read used to sit inside one interactive transaction, which is
 * exactly right on the shop PC and impossible on the hosted database. libSQL
 * over HTTP keeps an interactive transaction as a server-side stream addressed
 * by a token, and the stream does not survive a long conversation: the snapshot
 * makes one network round trip per statement — a `PRAGMA table_info` and at
 * least one `SELECT` for each of forty tables — and somewhere past the tenth
 * second Turso had closed the stream and answered the next statement with a
 * bare `HTTP 404`. Every backup this shop ever attempted failed that way, by
 * hand and on the schedule, and the console could only report the driver's own
 * words: `SERVER_ERROR: Server returned HTTP status 404`.
 *
 * ── What replaces it ─────────────────────────────────────────────────────────
 * The file driver keeps its transaction; nothing about the shop PC changes, and
 * a real transaction is strictly the better answer where one can be held. The
 * hosted path reads WITHOUT one and proves afterwards that it did not need it:
 * this signature is taken before the first row and after the last, and a
 * difference means something was written in between, which fails the backup
 * rather than storing it.
 *
 * ── What it can and cannot see ───────────────────────────────────────────────
 * Per table: how many rows there are, the highest rowid, and — where the table
 * records one — the latest `updated_at`. That catches every insert, every
 * delete, and every update to a table that timestamps its rows, which is every
 * table a till writes to. It would not notice an in-place edit of a row in a
 * table with no `updated_at` column; those are the append-only ones (movements,
 * document lines, the audit log) that nothing edits after the fact.
 *
 * One statement, one round trip, whatever the shop's size — the cost of the
 * check has to stay far below the cost of the read it is checking.
 */
export async function shopSignature(tables, terms = SIGNATURE_TERMS) {
  if (!tables.length) return 'empty';
  const rows = [];
  const size = Math.max(1, terms);
  for (let i = 0; i < tables.length; i += size) {
    // eslint-disable-next-line no-await-in-loop
    rows.push(...await signatureRows(tables.slice(i, i + size)));
  }
  const line = rows
    .map((r) => `${r.t}:${r.n}:${r.m}:${r.u}`)
    // Sorted, so how the tables were split across statements cannot change the
    // answer — the same shop signs the same whatever the batch size is.
    .sort()
    .join('|');
  return crypto.createHash('sha256').update(line).digest('hex');
}

/** One statement covering a handful of tables, with a per-table way out. */
async function signatureRows(batch) {
  try {
    return await getDb().prepare(batch.map(signatureTerm).join(' UNION ALL ')).all();
  } catch (error) {
    if (batch.length === 1 || !/compound SELECT/i.test(String(error?.message || ''))) throw error;
    // The ceiling turned out to be lower here than it is there. One table per
    // statement always fits, and a slow signature beats no backup.
    const rows = [];
    for (const table of batch) {
      // eslint-disable-next-line no-await-in-loop
      rows.push(...await getDb().prepare(signatureTerm(table)).all());
    }
    return rows;
  }
}

function signatureTerm(table) {
  const name = quoteName(table.name);
  // `MAX(updated_at)` only where the column is really there: naming a column
  // that does not exist is an error, not an empty answer.
  const stamp = table.columns.includes('updated_at') ? 'MAX(updated_at)' : "''";
  /**
   * SINGLE quotes around the table's own name, and it matters.
   *
   * `"web_order_lines"` is not a string in SQLite, it is an identifier — so
   * labelling each row with a double-quoted name asks for a COLUMN by that
   * name and fails with `no such column: web_order_lines`. `quoteName` has
   * already refused anything that is not a bare identifier, so the literal
   * below cannot carry a quote of its own.
   */
  return `SELECT '${table.name}' AS t, COUNT(*) AS n, `
    + `COALESCE(MAX(rowid), 0) AS m, COALESCE(${stamp}, '') AS u FROM ${name}`;
}

/**
 * Read every table, handing each finished JSONL part to `onPart`.
 *
 * `onRows` sees each batch as it is read, which is how the readable workbook is
 * built from the same pass rather than from a second one — reading the shop
 * twice would double both the time and the load on a database somebody is
 * standing at a till using.
 *
 * `budget` is the size ceiling. It is checked on every part, so a shop that has
 * outgrown this mechanism fails early and cheaply rather than after eight
 * minutes and a function that ran out of memory.
 */
export async function readSnapshot(options) {
  /**
   * A transaction where one can be held, a proof where one cannot.
   *
   * The shop PC keeps exactly what it had: `BEGIN`, read, `COMMIT`, and the
   * archive is a single point in time by construction. The hosted database
   * cannot hold a transaction open across a read this long (see
   * `shopSignature` above for the whole story), so there the read runs plainly
   * and is bracketed by a signature that fails the backup if anything moved.
   */
  if (driverName() === 'sqlite') return transaction(() => readTables(options));

  const before = await shopSignature(await describeTables());
  const result = await readTables(options);
  const after = await shopSignature(await describeTables());
  if (before !== after) throw new SnapshotRaceError();
  return result;
}

/** Every shop table with its column list — what a signature is taken over. */
async function describeTables() {
  const tables = await shopTables();
  const described = [];
  for (const table of tables) {
    // eslint-disable-next-line no-await-in-loop
    described.push({ name: table.name, columns: await columnsOf(table.name) });
  }
  return described;
}

async function readTables({
  onPart, onRows, budget = Infinity, redact = null,
}) {
  const tables = await shopTables();
    const manifestTables = [];
    const redacted = [];
    let totalRows = 0;
    let totalBytes = 0;

    for (const table of tables) {
      const columns = await columnsOf(table.name);
      if (!columns.length) continue;

      // Applied to the ROWS, before they are encoded and before `onRows` sees
      // them — so the archive, the workbooks and anything else built from this
      // one pass are redacted together and cannot disagree.
      const blank = (redact?.[table.name] || []).filter((column) => columns.includes(column));
      for (const column of blank) redacted.push(`${table.name}.${column}`);

      const quoted = columns.map(quoteName).join(', ');
      const select = table.hasRowid
        ? `SELECT rowid AS __rid, ${quoted} FROM ${quoteName(table.name)} WHERE rowid > ? ORDER BY rowid LIMIT ${READ_BATCH}`
        : `SELECT ${quoted} FROM ${quoteName(table.name)} LIMIT ${READ_BATCH} OFFSET ?`;

      const parts = [];
      let rows = 0;
      let cursor = 0;
      let buffer = [];
      let bufferBytes = 0;

      const flush = async () => {
        if (!buffer.length) return;
        const name = `snapshot/${table.name}.${String(parts.length + 1).padStart(4, '0')}.jsonl`;
        const body = Buffer.from(buffer.join('\n') + '\n', 'utf8');
        totalBytes += body.length;
        if (totalBytes > budget) {
          throw new SnapshotTooLargeError(totalBytes, budget);
        }
        await onPart(name, body);
        parts.push(name);
        buffer = [];
        bufferBytes = 0;
      };

      for (;;) {
        const batch = await getDb().prepare(select).all(cursor);
        if (!batch.length) break;

        if (blank.length) {
          for (const row of batch) for (const column of blank) row[column] = REDACTED;
        }
        if (onRows) await onRows(table.name, columns, batch);

        for (const row of batch) {
          const line = JSON.stringify(columns.map((column) => encodeValue(row[column])));
          buffer.push(line);
          bufferBytes += line.length + 1;
          rows += 1;
        }
        cursor = table.hasRowid ? batch[batch.length - 1].__rid : cursor + batch.length;
        if (bufferBytes >= PART_BYTES) await flush();
        if (batch.length < READ_BATCH) break;
      }
      await flush();

      manifestTables.push({
        name: table.name, columns, rows, parts,
      });
      totalRows += rows;
    }

  return {
    tables: manifestTables, totalRows, totalBytes, redacted,
  };
}

/** Thrown when a shop has outgrown this mechanism. Carries the two numbers. */
export class SnapshotTooLargeError extends Error {
  constructor(bytes, budget) {
    super(
      `This shop's data is larger than one backup may be: ${Math.round(bytes / 1048576)} MB `
      + `read so far against a ceiling of ${Math.round(budget / 1048576)} MB. `
      + 'Nothing was stored. Raise MM_BACKUP_MAX_BYTES, or move this shop to '
      + 'its database provider\'s own snapshots.',
    );
    this.name = 'SnapshotTooLargeError';
    this.bytes = bytes;
    this.budget = budget;
    this.code = 'BACKUP_TOO_LARGE';
  }
}

/**
 * The shop's own identity, written into its `settings` once and never again.
 *
 * The point of it is one refusal: a snapshot must never be restored into a
 * different shop's database. The control plane already scopes a backup to a
 * tenant row, and the console makes the operator type the slug — but a slug can
 * be reused and a tenant row can be re-pointed at another database, and neither
 * of those is a mistake anybody would notice until a live shop had been
 * overwritten with somebody else's stock. This id belongs to the DATABASE, so
 * it survives both.
 *
 * Created lazily rather than in `seedBaseline()` so that a shop adopted with
 * its data already in it gets one too — see migration 013, which backfills the
 * shops that existed before this feature did.
 */
export const INSTALL_ID_KEY = 'shop.install_id';

export async function shopInstallId({ create = true } = {}) {
  const db = getDb();
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').get(INSTALL_ID_KEY);
  if (row?.value) return row.value;
  if (!create) return null;
  const id = crypto.randomUUID();
  await db.prepare(`
    INSERT INTO settings (key, value, value_type, group_name, updated_at)
    VALUES (?, ?, 'string', 'system', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(INSTALL_ID_KEY, id, new Date().toISOString());
  return id;
}

/**
 * Put a snapshot back.
 *
 * One transaction for the whole thing, which is the entire answer to "what
 * happens if a restore fails halfway": nothing does. Every table is emptied and
 * refilled inside it, and any failure — a bad row, a dropped connection, a
 * function that hit its time limit — rolls the shop back to exactly the state it
 * was in before the restore started. There is no intermediate state a till can
 * read, because an uncommitted transaction is not visible to any other reader on
 * either driver.
 *
 * `PRAGMA defer_foreign_keys` is what makes emptying and refilling in one pass
 * legal: foreign keys are checked at COMMIT rather than per statement, so the
 * order tables are written in stops mattering and a circular reference
 * (`products.primary_image_id` against `product_images.product_id`) is not a
 * problem to be sequenced around. It also means the commit itself enforces
 * referential integrity over the finished result — a snapshot that would leave
 * the shop inconsistent is refused rather than committed.
 *
 * `readPart(name)` returns the bytes of one JSONL part. It is a callback so the
 * caller decides where they come from: the control plane, or a file on disk.
 */
export async function restoreSnapshot(manifest, readPart, { onProgress, allowRedacted = false } = {}) {
  const present = new Map((await shopTables()).map((t) => [t.name, t]));
  const applied = [];

  // A copy taken through the shop's own door carries no credentials (see
  // `CREDENTIAL_COLUMNS`). Restoring one is a legitimate act — it is the shop's
  // whole book — but it ends with a database nobody can sign in to, and finding
  // that out at the login screen is not acceptable. So it has to be asked for.
  if (manifest.redacted?.length && !allowRedacted) {
    throw new Error(
      `This archive was taken through a shop's own "download my data" door, so it does not `
      + `carry ${manifest.redacted.join(', ')}. Restoring it would leave a shop nobody can `
      + 'sign in to until a password is set again. Pass --i-accept-no-passwords (or '
      + 'allowRedacted) to do it anyway, then use scripts/reset-password.js.',
    );
  }

  // Checked before a single row is deleted: a snapshot naming a table this
  // database does not have means the database is older than the snapshot, and
  // emptying what IS here would destroy the shop to load half of it.
  for (const table of manifest.tables) {
    if (!present.has(table.name)) {
      throw new Error(
        `This snapshot contains a table this shop's database does not have ("${table.name}"). `
        + 'Run the fleet migration on this shop first, then restore again.',
      );
    }
    const columns = new Set(await columnsOf(table.name));
    const missing = table.columns.filter((column) => !columns.has(column));
    if (missing.length) {
      throw new Error(
        `This snapshot has columns "${table.name}" does not have here (${missing.join(', ')}). `
        + 'Run the fleet migration on this shop first, then restore again.',
      );
    }
  }

  return transaction(async () => {
    const db = getDb();
    await db.prepare('PRAGMA defer_foreign_keys = ON').run();

    // Everything the shop has now, not only what the snapshot names: a table
    // that gained rows after the snapshot was taken must not survive a restore
    // that is supposed to return the shop to that moment.
    for (const table of present.values()) {
      await db.prepare(`DELETE FROM ${quoteName(table.name)}`).run();
    }

    let restored = 0;
    for (const table of manifest.tables) {
      const columns = table.columns.map(quoteName).join(', ');
      const rowsPerStatement = Math.max(1, Math.floor(MAX_BIND_PARAMS / table.columns.length));
      const placeholder = `(${table.columns.map(() => '?').join(', ')})`;
      let written = 0;

      for (const part of table.parts) {
        const text = (await readPart(part)).toString('utf8');
        const lines = text.split('\n').filter(Boolean);
        for (let i = 0; i < lines.length; i += rowsPerStatement) {
          const slice = lines.slice(i, i + rowsPerStatement);
          const params = [];
          for (const line of slice) {
            for (const value of JSON.parse(line)) params.push(decodeValue(value));
          }
          const sql = `INSERT INTO ${quoteName(table.name)} (${columns}) VALUES `
            + `${new Array(slice.length).fill(placeholder).join(', ')}`;
          await db.prepare(sql).run(...params);
          written += slice.length;
        }
      }

      if (written !== table.rows) {
        throw new Error(
          `"${table.name}" should have restored ${table.rows} rows but ${written} arrived — `
          + 'the snapshot is incomplete. Nothing has been changed.',
        );
      }
      restored += written;
      applied.push({ table: table.name, rows: written });
      if (onProgress) onProgress({ table: table.name, rows: written });
    }

    return { tables: applied, rows: restored };
  });
}

export default {
  shopTables, columnsOf, readSnapshot, restoreSnapshot, shopInstallId,
  encodeValue, decodeValue, isShopTable, SnapshotTooLargeError, INSTALL_ID_KEY,
  CREDENTIAL_COLUMNS, REDACTED,
};
