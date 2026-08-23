/**
 * Per-shop backup: taking one, handing it over, and putting one back.
 *
 * ── What the owner downloads ─────────────────────────────────────────────────
 * One `.zip`, holding two answers to two different questions, because he asked
 * one sentence that contains both — "create a backup for each store, and let me
 * download all data":
 *
 *   snapshot/     every table, every row, as JSON Lines. Complete, including
 *                 password hashes and photographs, because a restore that
 *                 cannot sign anybody in is not a restore. Unreadable by a
 *                 person, and not meant to be.
 *   spreadsheets/ two `.xlsx` workbooks, Arabic and English, fifteen tabs each,
 *                 foreign keys resolved into names and every column headed with
 *                 the word the ERP itself uses. This is the half he opens.
 *   README.txt    what the other two are, in both languages.
 *
 * One file rather than a choice, because a shop owner asked to download his
 * data and should not have to know which of two buttons means what.
 *
 * The LAYOUT of that file is not defined here any more — it is in
 * `backupArchive.js`, because a shop's own administrator can now take the same
 * file from inside his own ERP (`services/DataExportService.js`) and the two
 * must never drift into producing different archives. What is still decided
 * here is everything about the STORED copy: retention, chunking, tickets and
 * restore. The one difference between the two files is what the shop's own copy
 * leaves out — see `CREDENTIAL_COLUMNS` in `snapshot.js`.
 *
 * ── What is STORED is only half of it, and that was a measurement ────────────
 * Only `snapshot/` is kept. The workbooks are built when somebody downloads,
 * out of the stored snapshot rather than out of the live shop — so the file
 * that arrives is a picture of the shop AT THE MOMENT THE BACKUP WAS TAKEN, not
 * of the shop today, which is the only thing "download this backup" can
 * honestly mean.
 *
 * The reason is a number. A year-old shop with 900 products, 1 500 clients,
 * 12 000 sales, 28 800 sale lines and 30 000 stock movements — 83 000 rows,
 * a 12.6 MB database — produces:
 *
 *     snapshot (JSONL, deflated)   1.33 MB      text compresses about 10:1
 *     two workbooks (.xlsx)        7.04 MB      already compressed; 84% of it
 *     ───────────────────────────────────
 *     whole download               8.37 MB
 *
 * Keeping the workbooks in every nightly copy would multiply the part nobody
 * restores from by the retention count: 14 × 8.37 MB = 117 MB per shop, which
 * is 9.4 GB across a fleet of eighty and past what the control plane's free
 * tier holds — spent entirely on spreadsheets nobody has asked for. Storing the
 * snapshot alone is 14 × 1.33 MB = 19 MB per shop, 1.5 GB at eighty shops.
 *
 * What it costs instead: a download does real work (decompress, resolve, emit)
 * rather than being a pure byte copy. That work is bounded by the same ceiling
 * as the backup itself, and it happens when a person is waiting for a file
 * rather than in a scheduled job nobody is watching, which is the better place
 * to spend it.
 *
 * ── Where the bytes live ─────────────────────────────────────────────────────
 * In the control-plane database, chunked (see `platform/schema.js`). Not a blob
 * store, because that is another account, another bill and another credential;
 * not a disk, because a Vercel function does not have one. The consequence is a
 * real cost in control-plane storage, which is why retention below is a number
 * and not a hope.
 *
 * ── The ceiling ──────────────────────────────────────────────────────────────
 * A shop's database grows and a serverless function does not. Two limits, both
 * checked while the backup is being built rather than after: the bytes actually
 * stored, and the raw bytes read. Crossing either aborts the run, deletes what
 * was written, and leaves a FAILED row that the console shows in red. Failing
 * loudly is the whole point — a shop silently missing its backups for a month
 * is the thing this feature exists to prevent, so a backup that cannot be taken
 * has to be as visible as one that can.
 */
import crypto from 'node:crypto';
import config from '../config/index.js';
import { platformDb } from './db.js';
import { openConnection, runWithTenant } from '../infrastructure/database/connection.js';
import { connectionFor, forget } from '../infrastructure/database/connections.js';
import { runMigrations } from '../infrastructure/database/migrations/index.js';
import { ZipWriter } from '../shared/zip.js';
import { ZipReader } from '../shared/zipReader.js';
import { assembleArchive, MANIFEST_NAME } from './backupArchive.js';
import {
  readSnapshot, restoreSnapshot, shopInstallId, SnapshotTooLargeError,
} from './snapshot.js';
import { NotFoundError, ValidationError, ConflictError } from '../shared/errors.js';
import { forgetTenant } from '../api/middleware/tenant.js';

/** One row of `tenant_backup_chunks`. Small enough to move over HTTP unremarkably. */
export const CHUNK_BYTES = Number(process.env.MM_BACKUP_CHUNK_BYTES || 256 * 1024);

/** The stored size of one backup. Crossing it fails the run. */
export const MAX_BACKUP_BYTES = Number(process.env.MM_BACKUP_MAX_BYTES || 64 * 1024 * 1024);

/** The uncompressed size read out of the shop, checked as it is read. */
export const MAX_RAW_BYTES = Number(process.env.MM_BACKUP_MAX_RAW_BYTES || 512 * 1024 * 1024);

/**
 * Retention, per shop, per kind.
 *
 * Deliberately three numbers rather than one, because the three kinds answer
 * three different fears:
 *
 *   scheduled   the shop nobody thought about. Fourteen daily runs is two weeks
 *               of history — long enough that damage noticed on a Monday can be
 *               undone from before the weekend it happened.
 *   manual      a copy somebody took on purpose, usually right before doing
 *               something risky. Five is enough to keep the ones that mattered.
 *   pre_restore the automatic copy taken immediately before a restore
 *               overwrites a shop. Three, and they are the most valuable rows in
 *               this table: they are what makes a restore into the wrong state
 *               itself undoable.
 *
 * What it costs, measured rather than guessed. The year-old shop described
 * above stores 1.33 MB a night, so:
 *
 *     one shop, full retention   14 + 5 + 3 = 22 copies  ≈  29 MB
 *     six shops (today)                                  ≈ 176 MB
 *     eighty shops                                       ≈ 2.3 GB
 *
 * against a Turso free tier of 9 GB and a paid one of 100 GB. So the fleet can
 * grow by more than ten times before retention is a bill rather than a setting,
 * and when it is, `MM_BACKUP_KEEP_SCHEDULED` is the knob.
 *
 * What this protects against: a bad edit, a bad import, a deleted price list, a
 * restore that turned out to be wrong — anything noticed within two weeks.
 * What it does NOT protect against, said plainly because a retention policy
 * that is believed to cover more than it does is worse than none:
 *
 *   - damage nobody notices for more than two weeks. The nightly copies from
 *     before it will have been pruned.
 *   - the loss of the CONTROL PLANE, which is where these bytes live. A backup
 *     of a shop stored beside the register of shops does not survive losing the
 *     register. That gap cannot be closed from inside this file; it is closed
 *     by the control-plane database provider's own point-in-time recovery, and
 *     DEPLOY-VERCEL.md says so where an owner will read it.
 *   - a shop's database being deleted at the provider. The backup survives —
 *     but restoring it needs a new database to restore INTO, which is a
 *     provisioning step, not a restore.
 */
export const KEEP = {
  scheduled: Number(process.env.MM_BACKUP_KEEP_SCHEDULED || 14),
  manual: Number(process.env.MM_BACKUP_KEEP_MANUAL || 5),
  pre_restore: Number(process.env.MM_BACKUP_KEEP_PRE_RESTORE || 3),
};

/** How long a ticket is good for. Minutes, because both are one deliberate act. */
const DOWNLOAD_TICKET_MS = 2 * 60_000;
const RESTORE_TICKET_MS = 5 * 60_000;

const now = () => new Date().toISOString();

/* ------------------------------------------------------------------ helpers */

async function tenantRow(slug) {
  const row = await platformDb().prepare('SELECT * FROM tenants WHERE slug = ?').get(slug);
  if (!row) throw new NotFoundError('Tenant', slug);
  return row;
}

const descriptorFor = (row) => ({
  driver: row.driver || 'sqlite',
  file: row.db_file,
  url: row.db_url,
  authToken: row.db_auth_token,
});

async function recordAudit(action, { tenantId, actor, detail }) {
  await platformDb().prepare(`
    INSERT INTO platform_audit (platform_user_id, tenant_id, action, detail, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(actor?.id ?? null, tenantId ?? null, action, detail ? JSON.stringify(detail) : null, now());
}

const toView = (row) => ({
  id: row.id,
  slug: row.slug,
  kind: row.kind,
  status: row.status,
  takenAt: row.taken_at,
  finishedAt: row.finished_at,
  byteSize: row.byte_size,
  rowCount: row.row_count,
  tableCount: row.table_count,
  sha256: row.sha256,
  error: row.error,
  truncatedSheets: (() => {
    try { return JSON.parse(row.manifest || '{}').truncatedSheets || []; } catch { return []; }
  })(),
});

/* -------------------------------------------------------------------- taking */

/**
 * One shop at a time, per process.
 *
 * Two backups of one shop at once would read the same database twice for no
 * reason and double the load on a till. This is an in-process guard, so it is
 * not a distributed lock — on a host running several instances two runs can
 * still overlap. That is survivable (they produce two independent, correct
 * backups) and the alternative, a lock row in the control plane, is a lock that
 * can be left behind by a function that was killed, which is worse.
 */
const running = new Set();

export async function take(slug, { kind = 'manual', actor = null } = {}) {
  if (!Object.hasOwn(KEEP, kind)) throw new ValidationError(`Unknown backup kind "${kind}"`);
  if (running.has(slug)) {
    throw new ConflictError(`A backup of "${slug}" is already being taken`);
  }
  running.add(slug);

  const row = await tenantRow(slug);
  const db = platformDb();
  const takenAt = now();

  const inserted = await db.prepare(`
    INSERT INTO tenant_backups (tenant_id, slug, kind, status, taken_at, created_by)
    VALUES (?, ?, ?, 'running', ?, ?)
  `).run(row.id, slug, kind, takenAt, actor?.id ?? null);
  const backupId = Number(inserted.lastInsertRowid);

  /* The sink: ZIP bytes in, chunk rows out. Peak memory is one chunk. */
  let pending = [];
  let pendingBytes = 0;
  let seq = 0;
  let stored = 0;
  const digest = crypto.createHash('sha256');

  const writeChunk = async (bytes) => {
    await db.prepare('INSERT INTO tenant_backup_chunks (backup_id, seq, bytes) VALUES (?, ?, ?)')
      .run(backupId, seq, bytes);
    seq += 1;
  };

  const sink = async (chunk) => {
    digest.update(chunk);
    stored += chunk.length;
    if (stored > MAX_BACKUP_BYTES) {
      throw new SnapshotTooLargeError(stored, MAX_BACKUP_BYTES);
    }
    pending.push(chunk);
    pendingBytes += chunk.length;
    while (pendingBytes >= CHUNK_BYTES) {
      const joined = Buffer.concat(pending);
      await writeChunk(joined.subarray(0, CHUNK_BYTES));
      const rest = joined.subarray(CHUNK_BYTES);
      pending = rest.length ? [rest] : [];
      pendingBytes = rest.length;
    }
  };

  try {
    const connection = await connectionFor(slug, () => openConnection(descriptorFor(row)));
    const zip = new ZipWriter(sink);

    const result = await runWithTenant({ slug }, connection, async () => {
      const installId = await shopInstallId();
      const snapshot = await readSnapshot({
        budget: MAX_RAW_BYTES,
        onPart: (name, bytes) => zip.add(name, bytes),
      });
      return { installId, snapshot };
    });

    const manifest = {
      format: 'mm-shop-snapshot',
      formatVersion: 1,
      takenAt,
      kind,
      shop: {
        slug,
        tenantId: row.id,
        nameEn: row.name_en,
        nameAr: row.name_ar,
        installId: result.installId,
        driver: row.driver,
      },
      app: { version: '1.0.0', controlPlane: config.platform.driver },
      tables: result.snapshot.tables,
      totals: { rows: result.snapshot.totalRows, rawBytes: result.snapshot.totalBytes },
    };
    await zip.add(MANIFEST_NAME, JSON.stringify(manifest, null, 2));
    await zip.finish();

    if (pendingBytes) await writeChunk(Buffer.concat(pending));
    pending = [];

    // What is recorded is the manifest WITHOUT its per-table parts lists, which
    // are only useful to a restore and are read out of the archive itself. The
    // console shows the table names and row counts, and this row stays small.
    const summary = {
      ...manifest,
      tables: manifest.tables.map((t) => ({ name: t.name, rows: t.rows })),
    };

    await db.prepare(`
      UPDATE tenant_backups
         SET status = 'ready', finished_at = ?, byte_size = ?, row_count = ?, table_count = ?,
             chunk_count = ?, sha256 = ?, manifest = ?, error = NULL
       WHERE id = ?
    `).run(
      now(), stored, result.snapshot.totalRows, manifest.tables.length, seq,
      digest.digest('hex'), JSON.stringify(summary), backupId,
    );

    await recordAudit('BACKUP', {
      tenantId: row.id,
      actor,
      detail: {
        slug, kind, backupId, bytes: stored, rows: result.snapshot.totalRows,
      },
    });

    const pruned = await prune(row.id);
    return { ...toView(await backupRow(backupId)), pruned };
  } catch (error) {
    // Nothing half-written survives: the chunks go, the row stays and says why.
    // A missing backup that nobody can see is the failure mode this whole
    // feature exists to prevent, so a failure is a row, not an absence.
    try {
      await db.prepare('DELETE FROM tenant_backup_chunks WHERE backup_id = ?').run(backupId);
      await db.prepare(`
        UPDATE tenant_backups SET status = 'failed', finished_at = ?, byte_size = 0,
               chunk_count = 0, error = ? WHERE id = ?
      `).run(now(), String(error.message || error).slice(0, 500), backupId);
    } catch { /* the original failure is the one worth reporting */ }
    await recordAudit('BACKUP_FAILED', {
      tenantId: row.id, actor, detail: { slug, kind, error: String(error.message || error).slice(0, 300) },
    });
    throw error;
  } finally {
    running.delete(slug);
  }
}

async function backupRow(id) {
  return platformDb().prepare('SELECT * FROM tenant_backups WHERE id = ?').get(id);
}

/* ------------------------------------------------------------------ pruning */

/** Keep the newest `KEEP[kind]` of each kind for one shop; delete the rest. */
export async function prune(tenantId) {
  const db = platformDb();
  const removed = [];
  for (const [kind, keep] of Object.entries(KEEP)) {
    const rows = await db.prepare(`
      SELECT id FROM tenant_backups
       WHERE tenant_id = ? AND kind = ? AND status = 'ready'
       ORDER BY taken_at DESC, id DESC
    `).all(tenantId, kind);
    for (const old of rows.slice(keep)) {
      await db.prepare('DELETE FROM tenant_backup_chunks WHERE backup_id = ?').run(old.id);
      await db.prepare('DELETE FROM tenant_backups WHERE id = ?').run(old.id);
      removed.push(old.id);
    }
  }
  // Failed and abandoned rows are kept only long enough to be seen. Three of
  // each is a signal; two hundred is a table nobody reads.
  const noise = await db.prepare(`
    SELECT id FROM tenant_backups
     WHERE tenant_id = ? AND status IN ('failed', 'running')
     ORDER BY taken_at DESC, id DESC
  `).all(tenantId);
  for (const old of noise.slice(5)) {
    await db.prepare('DELETE FROM tenant_backup_chunks WHERE backup_id = ?').run(old.id);
    await db.prepare('DELETE FROM tenant_backups WHERE id = ?').run(old.id);
    removed.push(old.id);
  }
  return removed;
}

/* ------------------------------------------------------------------ reading */

export async function list(slug) {
  const row = await tenantRow(slug);
  const rows = await platformDb().prepare(`
    SELECT * FROM tenant_backups WHERE tenant_id = ? ORDER BY taken_at DESC, id DESC LIMIT 100
  `).all(row.id);
  return {
    slug,
    keep: KEEP,
    maxBytes: MAX_BACKUP_BYTES,
    rows: rows.map(toView),
  };
}

/**
 * The one number the overview needs, for every shop, in one query.
 *
 * Deliberately reads only the control plane: the console must be able to show
 * that a shop has not been backed up for a month WITHOUT opening that shop's
 * database — which is exactly the case where the shop's database is the thing
 * that is broken.
 */
export async function fleetStatus() {
  const rows = await platformDb().prepare(`
    SELECT t.slug                                   AS slug,
           MAX(CASE WHEN b.status = 'ready' THEN b.taken_at END)  AS last_ready,
           MAX(b.taken_at)                          AS last_attempt,
           SUM(CASE WHEN b.status = 'ready' THEN 1 ELSE 0 END)    AS ready_count,
           SUM(CASE WHEN b.status = 'ready' THEN b.byte_size ELSE 0 END) AS bytes
      FROM tenants t
      LEFT JOIN tenant_backups b ON b.tenant_id = t.id
     GROUP BY t.id, t.slug
     ORDER BY t.slug
  `).all();

  const shops = rows.map((row) => ({
    slug: row.slug,
    lastBackupAt: row.last_ready || null,
    lastAttemptAt: row.last_attempt || null,
    count: Number(row.ready_count || 0),
    bytes: Number(row.bytes || 0),
    ageHours: row.last_ready
      ? Math.round((Date.now() - Date.parse(row.last_ready)) / 3_600_000)
      : null,
  }));

  return {
    shops,
    totalBytes: shops.reduce((sum, shop) => sum + shop.bytes, 0),
    // Whether the scheduled job can actually run. Without this the console
    // would show "never backed up" for a whole fleet with no explanation.
    scheduleArmed: Boolean(process.env.CRON_SECRET),
    staleAfterHours: STALE_AFTER_HOURS,
  };
}

/** Older than this and the console calls a shop overdue rather than merely old. */
export const STALE_AFTER_HOURS = Number(process.env.MM_BACKUP_STALE_HOURS || 36);

/** A reader over one stored backup, which never holds more than it is asked for. */
export async function openArchive(backupId, size) {
  const db = platformDb();
  return new ZipReader(async (start, length) => {
    if (length <= 0) return Buffer.alloc(0);
    const first = Math.floor(start / CHUNK_BYTES);
    const last = Math.floor((start + length - 1) / CHUNK_BYTES);
    const rows = await db.prepare(`
      SELECT seq, bytes FROM tenant_backup_chunks
       WHERE backup_id = ? AND seq >= ? AND seq <= ? ORDER BY seq
    `).all(backupId, first, last);
    const joined = Buffer.concat(rows.map((row) => row.bytes));
    const offset = start - first * CHUNK_BYTES;
    return joined.subarray(offset, offset + length);
  }, size);
}

/**
 * Build the file the owner actually receives, out of the backup that was kept.
 *
 * Nothing here reads the shop. Every value in the workbooks comes from the
 * stored snapshot, so a backup downloaded a week after it was taken shows the
 * shop as it was that night — which is the only thing "download this backup"
 * can honestly mean, and it also means a shop whose database is unreachable can
 * still have its data handed over.
 *
 * Memory is bounded by the same two things that bound taking one: a snapshot
 * part is read, used and dropped one at a time, and each sheet stops at
 * `MAX_SHEET_ROWS`. A table with no sheet — the photographs, the audit log — is
 * copied through WITHOUT being parsed at all, which is what stops an 18 MB
 * column of base64 being turned into JavaScript objects for no reason.
 */
export async function buildDownload(backup, write) {
  const archive = await openArchive(backup.id, backup.byte_size);
  const manifest = await archive.readJson(MANIFEST_NAME);

  return assembleArchive({
    write,
    shop: { slug: backup.slug, nameEn: manifest.shop.nameEn, nameAr: manifest.shop.nameAr },
    takenAt: manifest.takenAt,
    redacted: manifest.redacted || [],
    produce: async ({ addPart, handles, feed }) => {
      for (const table of manifest.tables) {
        const wanted = handles(table.name);
        for (const part of table.parts) {
          const bytes = await archive.read(part);
          await addPart(part, bytes);
          if (!wanted) continue;
          const rows = bytes.toString('utf8').split('\n').filter(Boolean).map((line) => {
            const values = JSON.parse(line);
            const row = {};
            table.columns.forEach((column, index) => { row[column] = values[index]; });
            return row;
          });
          feed(table.name, table.columns, rows);
        }
      }
      return manifest;
    },
  });
}

/* ------------------------------------------------------------------ tickets */

const token = () => crypto.randomBytes(32).toString('base64url');

async function requireBackup(slug, backupId) {
  const tenant = await tenantRow(slug);
  const backup = await platformDb()
    .prepare('SELECT * FROM tenant_backups WHERE id = ? AND tenant_id = ?')
    .get(Number(backupId), tenant.id);
  if (!backup) throw new NotFoundError('Backup', String(backupId));
  return { tenant, backup };
}

async function issueTicket({
  purpose, tenantId, backupId, actor, plan, ttl,
}) {
  const value = token();
  const created = new Date();
  await platformDb().prepare(`
    INSERT INTO backup_tickets (token, purpose, tenant_id, backup_id, platform_user_id, plan, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    value, purpose, tenantId, backupId, actor?.id ?? null,
    plan ? JSON.stringify(plan) : null,
    created.toISOString(), new Date(created.getTime() + ttl).toISOString(),
  );
  return { token: value, expiresAt: new Date(created.getTime() + ttl).toISOString() };
}

/**
 * Spend a ticket. One statement does the checking and the spending together, so
 * two requests arriving at once cannot both find it unused.
 */
async function spendTicket(value, purpose, actor) {
  const db = platformDb();
  const spent = await db.prepare(`
    UPDATE backup_tickets SET used_at = ?
     WHERE token = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?
  `).run(now(), String(value || ''), purpose, now());
  if (!spent.changes) {
    throw new ValidationError(
      'That confirmation has already been used or has expired — start again.',
    );
  }
  const ticket = await db.prepare('SELECT * FROM backup_tickets WHERE token = ?').get(value);
  // Bound to the person who asked for it: a ticket that leaked out of one
  // browser is useless in another session.
  if (ticket.platform_user_id !== (actor?.id ?? null)) {
    throw new ValidationError('That confirmation belongs to a different sign-in.');
  }
  // Expired tickets are cleared opportunistically; there is no job for it and
  // the table is tiny.
  await db.prepare('DELETE FROM backup_tickets WHERE expires_at < ?')
    .run(new Date(Date.now() - 3_600_000).toISOString());
  return ticket;
}

export async function downloadTicket(slug, backupId, actor) {
  const { tenant, backup } = await requireBackup(slug, backupId);
  if (backup.status !== 'ready') {
    throw new ValidationError('That backup did not finish, so there is nothing to download.');
  }
  const issued = await issueTicket({
    purpose: 'download', tenantId: tenant.id, backupId: backup.id, actor, ttl: DOWNLOAD_TICKET_MS,
  });
  await recordAudit('BACKUP_DOWNLOAD_REQUESTED', {
    tenantId: tenant.id, actor, detail: { slug, backupId: backup.id },
  });
  return {
    ...issued,
    filename: `${slug}-backup-${backup.taken_at.slice(0, 19).replace(/[:T]/g, '-')}.zip`,
    byteSize: backup.byte_size,
  };
}

export async function claimDownload(value, actor) {
  const ticket = await spendTicket(value, 'download', actor);
  const backup = await backupRow(ticket.backup_id);
  if (!backup || backup.status !== 'ready') throw new NotFoundError('Backup', String(ticket.backup_id));
  await recordAudit('BACKUP_DOWNLOADED', {
    tenantId: backup.tenant_id, actor, detail: { slug: backup.slug, backupId: backup.id },
  });
  return backup;
}

/* ---------------------------------------------------------------- restoring */

/**
 * What a restore would do, worked out before anything is touched.
 *
 * The console shows this and only then offers the button, because "restore" is
 * a word and "your 412 sales become the 380 sales of the 3rd of August" is a
 * decision. The plan is stored on the ticket, so what runs is provably what was
 * approved.
 */
export async function planRestore(slug, backupId, actor) {
  const { tenant, backup } = await requireBackup(slug, backupId);
  if (backup.status !== 'ready') {
    throw new ValidationError('That backup did not finish and cannot be restored.');
  }

  const manifest = JSON.parse(backup.manifest || '{}');
  if (manifest.shop?.slug !== slug || manifest.shop?.tenantId !== tenant.id) {
    throw new ValidationError(
      `That backup was taken from "${manifest.shop?.slug || 'another shop'}" and cannot be restored into "${slug}".`,
    );
  }

  const connection = await connectionFor(slug, () => openConnection(descriptorFor(tenant)));
  const current = await runWithTenant({ slug }, connection, async () => {
    const installId = await shopInstallId({ create: false });
    const counts = {};
    for (const table of ['users', 'products', 'customers', 'sales', 'purchase_orders']) {
      try {
        const row = await connection.facade.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
        counts[table] = row.n;
      } catch { counts[table] = null; }
    }
    return { installId, counts };
  });

  // The refusal that makes "impossible to do to the wrong shop" a property of
  // the code. The slug and the tenant id both matched above; this is the
  // database's own identity, which survives a slug being reused and a tenant
  // row being re-pointed at somebody else's database.
  if (current.installId && manifest.shop?.installId && current.installId !== manifest.shop.installId) {
    throw new ValidationError(
      'This backup belongs to a different database than the one this shop now points at. '
      + 'Restoring it here would overwrite a shop with another shop\'s data, so it is refused. '
      + 'Use scripts/restore-shop.js with --i-know-this-is-a-different-database if this is deliberate.',
    );
  }

  const snapshotCounts = Object.fromEntries(
    (manifest.tables || []).map((table) => [table.name, table.rows]),
  );

  const plan = {
    slug,
    backupId: backup.id,
    takenAt: backup.taken_at,
    kind: backup.kind,
    byteSize: backup.byte_size,
    previousStatus: tenant.status,
    before: current.counts,
    after: {
      users: snapshotCounts.users ?? null,
      products: snapshotCounts.products ?? null,
      customers: snapshotCounts.customers ?? null,
      sales: snapshotCounts.sales ?? null,
      purchase_orders: snapshotCounts.purchase_orders ?? null,
    },
    tables: (manifest.tables || []).length,
    rows: backup.row_count,
  };

  const issued = await issueTicket({
    purpose: 'restore', tenantId: tenant.id, backupId: backup.id, actor, plan, ttl: RESTORE_TICKET_MS,
  });
  return { plan, ...issued };
}

/**
 * Do it.
 *
 * The order below is the safety design, and each step is there because of a way
 * this goes wrong:
 *
 *  1. The slug is typed again by hand and must match. A ticket is proof that a
 *     plan was seen; typing the name is proof of which shop it was for.
 *  2. The shop is SUSPENDED first. A restore over a live till is worse than
 *     four minutes of "temporarily unavailable": a cashier mid-sale would post
 *     a sale into a database that is being replaced underneath them.
 *  3. A pre-restore backup is taken. A restore is the one operation here that
 *     destroys data, so it is made undoable before it is allowed to happen.
 *  4. Migrations are run on the target, so a shop that is behind the snapshot's
 *     schema gains the columns before anything is written.
 *  5. The restore itself is one transaction (see `snapshot.js`). It either
 *     happens or it does not; there is no half-restored shop.
 *  6. The shop is resumed only if step 5 succeeded, and only to the status it
 *     had before. A failed restore leaves the shop SUSPENDED and says so — a
 *     shop that goes on trading after a restore whose outcome nobody knows is
 *     the worst result available here.
 */
export async function restore(slug, { ticket, confirmSlug, actor } = {}) {
  if (String(confirmSlug || '').trim() !== slug) {
    throw new ValidationError(
      `Type the shop's name (${slug}) exactly to confirm which shop is being overwritten.`,
    );
  }
  const spent = await spendTicket(ticket, 'restore', actor);
  const tenant = await tenantRow(slug);
  if (spent.tenant_id !== tenant.id) {
    throw new ValidationError('That confirmation was for a different shop.');
  }
  const backup = await backupRow(spent.backup_id);
  if (!backup || backup.tenant_id !== tenant.id || backup.status !== 'ready') {
    throw new NotFoundError('Backup', String(spent.backup_id));
  }

  const plan = JSON.parse(spent.plan || '{}');
  const db = platformDb();
  const previousStatus = plan.previousStatus || tenant.status;

  await db.prepare('UPDATE tenants SET status = ?, updated_at = ? WHERE id = ?')
    .run('suspended', now(), tenant.id);
  await forgetTenant(slug);
  await recordAudit('RESTORE_STARTED', {
    tenantId: tenant.id, actor, detail: { slug, backupId: backup.id, takenAt: backup.taken_at },
  });

  let safetyCopy = null;
  try {
    safetyCopy = await take(slug, { kind: 'pre_restore', actor });
  } catch (error) {
    await db.prepare('UPDATE tenants SET status = ?, updated_at = ? WHERE id = ?')
      .run(previousStatus, now(), tenant.id);
    await forgetTenant(slug);
    throw new ValidationError(
      'A safety copy of this shop could not be taken, so the restore was not started and '
      + `nothing was changed. (${error.message})`,
    );
  }

  try {
    const archive = await openArchive(backup.id, backup.byte_size);
    const manifest = await archive.readJson(MANIFEST_NAME);
    if (manifest.shop?.slug !== slug || manifest.shop?.tenantId !== tenant.id) {
      throw new ValidationError(
        `The archive says it was taken from "${manifest.shop?.slug}", not from "${slug}".`,
      );
    }

    // Not reused from the cache: a restore must talk to the database the tenant
    // row names right now, and the cached handle is dropped either way below.
    const connection = await openConnection(descriptorFor(tenant));
    let result;
    try {
      result = await runWithTenant({ slug }, connection, async () => {
        await runMigrations();
        return restoreSnapshot(manifest, (name) => archive.read(name));
      });
    } finally {
      await connection.close();
    }

    await db.prepare('UPDATE tenants SET status = ?, updated_at = ? WHERE id = ?')
      .run(previousStatus, now(), tenant.id);
    await forget(slug);
    await forgetTenant(slug);

    await recordAudit('RESTORE', {
      tenantId: tenant.id,
      actor,
      detail: {
        slug,
        backupId: backup.id,
        takenAt: backup.taken_at,
        rows: result.rows,
        safetyCopyId: safetyCopy?.id ?? null,
      },
    });

    return {
      restored: true,
      slug,
      backupId: backup.id,
      takenAt: backup.taken_at,
      rows: result.rows,
      tables: result.tables.length,
      safetyCopyId: safetyCopy?.id ?? null,
      status: previousStatus,
    };
  } catch (error) {
    await forget(slug);
    await forgetTenant(slug);
    await recordAudit('RESTORE_FAILED', {
      tenantId: tenant.id,
      actor,
      detail: {
        slug,
        backupId: backup.id,
        safetyCopyId: safetyCopy?.id ?? null,
        error: String(error.message || error).slice(0, 300),
      },
    });
    // Deliberately left suspended. The transaction rolled the shop back, so its
    // data is what it was — but nobody watching a failed restore knows that
    // yet, and a shop that resumes trading on its own after one is a shop whose
    // owner finds out from a customer.
    error.message = `${error.message} — "${slug}" has been left suspended. `
      + `Its data was not changed (the restore is one transaction). A safety copy `
      + `was taken first${safetyCopy ? ` (backup #${safetyCopy.id})` : ''}. `
      + 'Resume the shop from its Settings tab once you have decided what to do.';
    throw error;
  }
}

export default {
  take, list, prune, fleetStatus, downloadTicket, claimDownload, buildDownload,
  openArchive, planRestore, restore, KEEP, MAX_BACKUP_BYTES, STALE_AFTER_HOURS,
};
