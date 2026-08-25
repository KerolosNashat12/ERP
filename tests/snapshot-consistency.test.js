/**
 * A backup that is one moment, or no backup at all — `platform/snapshot.js`.
 *
 * ── What broke ───────────────────────────────────────────────────────────────
 * The read of a whole shop sat inside one interactive transaction. On the shop
 * PC that is exactly right and still is. On the hosted database it could not
 * work and never had: libSQL over HTTP keeps an interactive transaction as a
 * server-side stream, the snapshot makes a round trip per statement — a
 * `PRAGMA table_info` and at least one `SELECT` for each of forty tables — and
 * somewhere past the tenth second Turso closed the stream and answered the next
 * statement with a bare `HTTP 404`. Every backup this platform ever took of a
 * hosted shop failed, by hand and on the schedule, and the only thing the
 * console could say was the driver's own sentence:
 *
 *     SERVER_ERROR: Server returned HTTP status 404
 *
 * ── What replaced it ─────────────────────────────────────────────────────────
 * The file driver keeps its transaction. The hosted path reads without one and
 * proves afterwards that it did not need one: a signature of every table is
 * taken before the first row and after the last, and a difference means the
 * shop was written to mid-read. That fails the backup rather than storing it,
 * because a torn archive is worse than a missing one — it is the thing somebody
 * reaches for on the day it has to be right.
 *
 * ── What these tests hold ────────────────────────────────────────────────────
 *  - the signature notices an insert, a delete, and an in-place update;
 *  - a write DURING the read is caught, and the half-written archive is gone;
 *  - one retry is allowed, so an ordinary till does not lose its nightly copy;
 *  - and a hosted backup still round-trips, which is the whole point.
 *
 * The first test is also the one that would have caught this file's own first
 * bug: the table name was labelled with double quotes, which SQLite reads as an
 * IDENTIFIER, so the signature asked for a column called `web_order_lines` and
 * every hosted backup failed with `no such column`.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const testDataDir = path.join(here, '..', 'data', 'snapshot-consistency-test');

process.env.MM_PLATFORM = '1';
process.env.MM_PLATFORM_DB = path.join(testDataDir, 'platform.db');
process.env.MM_TENANTS_DIR = path.join(testDataDir, 'tenants');
process.env.MM_DB_FILE = path.join(testDataDir, 'unused-default.db');
process.env.MM_BACKUPS_DIR = path.join(testDataDir, 'backups');
process.env.MM_BACKUP_PART_BYTES = '4096';
// Small enough that a first attempt has already written chunk rows to the
// control plane before it loses the race — otherwise the retry test would
// prove only that an empty buffer can be thrown away.
process.env.MM_BACKUP_CHUNK_BYTES = '1024';
process.env.MM_BACKUP_READ_BATCH = '25';

fs.rmSync(testDataDir, { recursive: true, force: true });
fs.mkdirSync(path.join(testDataDir, 'tenants'), { recursive: true });

const {
  initDb, closeDb, openConnection, runWithTenant,
} = await import('../src/infrastructure/database/connection.js');
const { initPlatformDb, closePlatformDb, platformDb } = await import('../src/platform/db.js');
const tenantService = (await import('../src/platform/TenantService.js')).default;
const backupService = await import('../src/platform/BackupService.js');
const {
  shopSignature, shopTables, columnsOf, readSnapshot, SnapshotRaceError,
} = await import('../src/platform/snapshot.js');
const { connectionFor, forget } = await import('../src/infrastructure/database/connections.js');
const { MODULES } = await import('../src/shared/permissions.js');

before(async () => {
  await initDb();
  await initPlatformDb();
});

after(async () => {
  await closeDb();
  await closePlatformDb();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

/** A hosted shop: `file:` libSQL is the same client the real one speaks. */
async function makeShop(slug) {
  const file = path.join(testDataDir, 'tenants', `${slug}.db`);
  await tenantService.create({
    slug,
    nameEn: `${slug} shop`,
    nameAr: `متجر ${slug}`,
    modules: Object.keys(MODULES),
    database: { mode: 'libsql', url: `file:${file}` },
  });
  return slug;
}

async function withShop(slug, fn) {
  const row = await platformDb().prepare('SELECT * FROM tenants WHERE slug = ?').get(slug);
  const connection = await openConnection({
    driver: row.driver, file: row.db_file, url: row.db_url, authToken: row.db_auth_token,
  });
  try {
    return await runWithTenant({ slug }, connection, () => fn(connection.facade));
  } finally {
    await connection.close();
  }
}

/** The signature, taken the way `readSnapshot` takes it. */
async function signature(terms) {
  const tables = await shopTables();
  const described = [];
  for (const table of tables) {
    described.push({ name: table.name, columns: await columnsOf(table.name) });
  }
  return shopSignature(described, terms);
}

async function fill(slug, rows = 40) {
  await withShop(slug, async (db) => {
    for (let i = 1; i <= rows; i += 1) {
      await db.prepare('INSERT INTO customers (code, name, phone) VALUES (?, ?, ?)')
        .run(`C-${i}`, `عميل ${i}`, `0100000${String(i).padStart(4, '0')}`);
    }
  });
}

test('the signature notices anything that could tear a backup', async (ctx) => {
  const slug = await makeShop('sig');
  await fill(slug, 20);

  await ctx.test('it is a real answer, not an error swallowed into a constant', async () => {
    // The first version of this labelled each row `"customers"` — double quotes,
    // which SQLite reads as an identifier — and every call failed with
    // `no such column: customers`. A signature that cannot be taken is a
    // backup that cannot be taken.
    await withShop(slug, async () => {
      const value = await signature();
      assert.match(value, /^[0-9a-f]{64}$/, 'expected a sha256 of the shop, got: ' + value);
    });
  });

  await ctx.test('how many statements it takes cannot change the answer', async () => {
    /**
     * The signature began as ONE `UNION ALL` over all forty-four tables — one
     * round trip whatever the shop's size. SQLite allows five hundred compound
     * terms and ran it happily; Turso answered every hosted backup with
     * `SQLITE_UNKNOWN: SQLite error: too many terms in compound SELECT`. It is
     * split into batches now, which only works if the split is invisible: the
     * same shop has to sign the same whether that took one statement or forty.
     */
    await withShop(slug, async () => {
      const whole = await signature(1000);
      assert.equal(await signature(8), whole, 'batching changed the signature');
      assert.equal(await signature(1), whole, 'one table per statement changed it');
    });
  });

  await ctx.test('the same shop, untouched, signs the same twice', async () => {
    await withShop(slug, async () => {
      assert.equal(await signature(), await signature());
    });
  });

  await ctx.test('an insert changes it', async () => {
    await withShop(slug, async (db) => {
      const before = await signature();
      await db.prepare('INSERT INTO customers (code, name) VALUES (?, ?)').run('C-NEW', 'جديد');
      assert.notEqual(await signature(), before);
    });
  });

  await ctx.test('a delete changes it', async () => {
    await withShop(slug, async (db) => {
      const before = await signature();
      await db.prepare('DELETE FROM customers WHERE code = ?').run('C-1');
      assert.notEqual(await signature(), before);
    });
  });

  await ctx.test('an in-place edit changes it, where the table records one', async () => {
    /**
     * This is the one a count and a max rowid cannot see on their own, and the
     * reason `updated_at` is in the signature at all: a price corrected while
     * the archive is being written would otherwise pass unnoticed.
     */
    await withShop(slug, async (db) => {
      const before = await signature();
      await db.prepare('UPDATE customers SET name = ?, updated_at = ? WHERE code = ?')
        .run('اسم متغير', new Date(Date.now() + 60_000).toISOString(), 'C-2');
      assert.notEqual(await signature(), before);
    });
  });
});

test('a shop that is open for business can still be copied', async (ctx) => {
  const slug = await makeShop('race');
  await fill(slug, 60);

  /** Reads the whole shop, running `during` once between two tables. */
  async function readWith(db, during) {
    let fired = false;
    const rows = new Map();
    const result = await readSnapshot({
      budget: Infinity,
      onPart: async () => {
        if (fired) return;
        fired = true;
        await during(db);
      },
      onRows: (table, columns, batch) => {
        const seen = rows.get(table) || [];
        for (const row of batch) seen.push(row);
        rows.set(table, seen);
      },
    });
    assert.ok(fired, 'the test never actually wrote anything, so it proved nothing');
    return { result, rows };
  }

  await ctx.test('a sale rung up mid-read is left out, not half in', async () => {
    /**
     * The insert is the common case by far, and the one that used to fail the
     * whole backup. It cannot tear anything now: the read stops at the rowid
     * each table had when it started, so the new row is in NO part of the
     * archive rather than in some of them.
     */
    await withShop(slug, async (db) => {
      const { result, rows } = await readWith(db, (handle) => handle
        .prepare('INSERT INTO customers (code, name) VALUES (?, ?)')
        .run('C-DURING', 'أثناء النسخ'));
      const codes = (rows.get('customers') || []).map((row) => row.code);
      assert.ok(!codes.includes('C-DURING'), 'a row written mid-read got into the archive');
      assert.ok(result.totalRows > 0, 'the snapshot read nothing at all');
    });
  });

  await ctx.test('an edit mid-read is allowed, and the archive says so', async () => {
    await withShop(slug, async (db) => {
      const { result } = await readWith(db, (handle) => handle
        .prepare('UPDATE customers SET name = ?, updated_at = ? WHERE code = ?')
        .run('اسم اتغير', new Date(Date.now() + 60_000).toISOString(), 'C-3'));
      assert.ok(result.concurrentEdits.includes('customers'),
        `an in-place edit went unrecorded: ${JSON.stringify(result.concurrentEdits)}`);
    });
  });

  await ctx.test('a DELETE mid-read fails it, and names the table', async () => {
    await withShop(slug, async (db) => {
      await assert.rejects(
        () => readWith(db, (handle) => handle
          .prepare('DELETE FROM customers WHERE code = ?').run('C-7')),
        (error) => {
          assert.ok(error instanceof SnapshotRaceError, `expected SnapshotRaceError, got ${error}`);
          assert.equal(error.code, 'SNAPSHOT_RACE');
          // The message is forwarded to whoever has to decide what to do about
          // it, so it has to carry the evidence, not just the verdict.
          assert.match(error.message, /customers/);
          assert.deepEqual(error.changes.map((c) => c.table), ['customers']);
          return true;
        },
      );
    });
  });

  await ctx.test('a quiet shop is not accused of anything', async () => {
    await withShop(slug, async () => {
      const result = await readSnapshot({ budget: Infinity, onPart: async () => {} });
      assert.ok(result.totalRows > 0, 'the snapshot read nothing at all');
      assert.deepEqual(result.concurrentEdits, []);
    });
  });
});

test('a hosted backup is taken, stored, and readable', async (ctx) => {
  const slug = await makeShop('hosted');
  await fill(slug, 30);

  await ctx.test('it succeeds where every one of them used to 404', async () => {
    const view = await backupService.take(slug, { kind: 'manual' });
    assert.equal(view.status, 'ready', `backup did not complete: ${JSON.stringify(view)}`);
    assert.ok(view.byteSize > 0, 'a ready backup with no bytes in it');
    assert.ok(view.rowCount > 30, 'fewer rows than were put in');
  });

  await ctx.test('and nothing half-written was left behind by the attempt', async () => {
    const rows = await platformDb()
      .prepare("SELECT status, COUNT(*) AS n FROM tenant_backups WHERE slug = ? GROUP BY status")
      .all(slug);
    const failed = rows.find((r) => r.status === 'failed');
    assert.ok(!failed, `a failed backup row survived: ${JSON.stringify(rows)}`);
  });
});


test('a delete mid-read costs a retry, not the backup', async (ctx) => {
  const slug = await makeShop('retry');
  await fill(slug, 60);

  const row = await platformDb().prepare('SELECT * FROM tenants WHERE slug = ?').get(slug);
  const descriptor = {
    driver: row.driver, file: row.db_file, url: row.db_url, authToken: row.db_auth_token,
  };

  /**
   * The till: a genuinely separate connection, because the point is a write
   * from OUTSIDE the read, the way a cashier's is. It DELETES, because that is
   * the only kind of write that still fails a backup — an insert is excluded by
   * the ceiling and an edit is recorded and allowed.
   */
  const till = await openConnection(descriptor);
  const reader = await openConnection(descriptor);

  let injected = 0;
  let selects = 0;
  let chunksWrittenByFirstAttempt = 0;

  /**
   * Wrapping the reader's own `prepare` puts the sale at a KNOWN point inside
   * the read — deep enough that the first attempt has already streamed bytes
   * into the control plane. A timer would land there only by luck, and a test
   * that passes by luck is not a test.
   */
  const realPrepare = reader.facade.prepare.bind(reader.facade);
  const facade = Object.create(reader.facade);
  facade.prepare = (sql) => {
    const stmt = realPrepare(sql);
    if (!/^SELECT rowid AS __rid/.test(sql)) return stmt;
    return {
      ...stmt,
      all: async (...params) => {
        const rows = await stmt.all(...params);
        selects += 1;
        if (selects === 25 && injected === 0) {
          injected += 1;
          const counted = await platformDb()
            .prepare('SELECT COUNT(*) AS n FROM tenant_backup_chunks').get();
          chunksWrittenByFirstAttempt = counted.n;
          await runWithTenant({ slug }, till, () => till.facade
            .prepare('DELETE FROM customers WHERE code = ?').run('C-9'));
        }
        return rows;
      },
    };
  };
  // `take` resolves its connection through this cache, so seeding it is how the
  // instrumented reader gets used without changing a line of BackupService.
  await connectionFor(slug, async () => ({ ...reader, facade }));

  let view;
  await ctx.test('the backup still completes', async () => {
    view = await backupService.take(slug, { kind: 'manual' });
    assert.equal(injected, 1, 'nothing was written mid-read, so nothing was proved');
    assert.ok(chunksWrittenByFirstAttempt > 0,
      'the first attempt stored no chunks, so discarding them proved nothing');
    assert.equal(view.status, 'ready', `backup did not recover: ${JSON.stringify(view)}`);
  });

  await ctx.test('and the second attempt is the one that was stored', async () => {
    const parts = await platformDb()
      .prepare('SELECT bytes FROM tenant_backup_chunks WHERE backup_id = ? ORDER BY seq')
      .all(view.id);
    const size = parts.reduce((total, part) => total + Buffer.from(part.bytes).length, 0);
    // Every byte in the control plane belongs to the attempt that succeeded:
    // the discarded chunks are gone and `seq` started again from zero, so the
    // stored size is the stored size and not the sum of two passes.
    assert.equal(size, view.byteSize, 'stale chunks from the first attempt survived');
    const stored = await platformDb()
      .prepare('SELECT chunk_count FROM tenant_backups WHERE id = ?').get(view.id);
    assert.equal(parts.length, stored.chunk_count);
  });

  await ctx.test('and only one backup row exists, marked ready', async () => {
    const rows = await platformDb()
      .prepare('SELECT status FROM tenant_backups WHERE slug = ?').all(slug);
    assert.deepEqual(rows.map((r) => r.status), ['ready']);
  });

  forget(slug);
  await till.close();
  await reader.close();
});
