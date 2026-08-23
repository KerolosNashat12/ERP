/**
 * The shop's own door to its own data.
 *
 * ── Why this exists at all ───────────────────────────────────────────────────
 * The backup machinery next door (`platform/BackupService.js`) was given
 * exactly one door on purpose: the platform owner's console. The reasoning was
 * sound — a backup is the shop's entire book, every price, every cost, every
 * customer's phone number and every salary in one file — and none of it is
 * undone here.
 *
 * What it missed is who the door belonged to. For M&M the shop's administrator
 * and the platform's owner are the same man, so one door looked like enough.
 * For a paying customer they are two different companies, and a shop
 * administrator who wants a copy of his own books would have had to ask the
 * platform's owner for it. Meanwhile the landing page this platform is sold
 * with promises, in both languages: «بياناتك بتاعتك، وتقدر تاخد نسخة منها» —
 * "Your data is yours, and you can take a copy of it".
 *
 * So the shop gets its own door. Not the platform's door moved — its own,
 * serving exactly one shop: the one the person pressing the button is signed
 * into. It cannot name another shop, because there is no slug in it anywhere:
 * it reads through `getDb()`, which is the caller's own tenant connection.
 *
 * ── What comes out of it ─────────────────────────────────────────────────────
 * The same archive the console hands over, assembled by the same code
 * (`platform/backupArchive.js`) — README, the JSONL snapshot, and the two
 * bilingual workbooks — with one deliberate difference: the credentials are
 * redacted (`CREDENTIAL_COLUMNS` in `platform/snapshot.js`). The console's copy
 * exists to be restored, and a restore that cannot sign anybody in is not a
 * restore. This copy exists to be KEPT — on a laptop, in an email, on a phone —
 * and a bcrypt hash in a file like that is an offline cracking exercise handed
 * over for free. Everything else, every row the shop owns, is in it.
 *
 * ── Nothing is stored ────────────────────────────────────────────────────────
 * The archive is built while the response is being written and is never kept
 * anywhere: not in the shop's database, not in the control plane, not on a
 * disk a serverless function does not have. That is the whole difference in
 * cost between this and the console's backups — this one spends CPU while a
 * person waits, and no storage at all.
 *
 * ── What it costs, and the two numbers that bound it ─────────────────────────
 * Building one reads every row of a shop through a metered database, so this
 * must not be a button a bored user can hold down. Two limits, both derived
 * from the shop's OWN audit log rather than from memory in this process —
 * because on a serverless host the next press very likely lands on a different
 * instance, and a limit that lives in a Map is not a limit:
 *
 *   COOLDOWN      one export per shop per ten minutes. Long enough that a
 *                 double-press or a second person trying the same button costs
 *                 one read of the shop rather than two; short enough that
 *                 nobody who genuinely needs a fresh copy is made to wait.
 *   DAILY CEILING six per shop per rolling day. A shop administrator who wants
 *                 his data twice in an afternoon is doing something normal; one
 *                 who wants it forty times is either testing the button or
 *                 something is wrong, and either way the shop's database should
 *                 not pay for it.
 *
 * Plus an in-process guard against the exact double-click, so two overlapping
 * presses on one instance do not both open a read transaction.
 */
import config from '../config/index.js';
import repositories from '../infrastructure/repositories/index.js';
import { getDb, currentTenant, driverName } from '../infrastructure/database/connection.js';
import { assembleArchive } from '../platform/backupArchive.js';
import {
  readSnapshot, shopInstallId, CREDENTIAL_COLUMNS, SnapshotTooLargeError,
} from '../platform/snapshot.js';
import { companyNameFrom } from '../shared/branding.js';
import { AppError } from '../shared/errors.js';
import auditService from './AuditService.js';

/** How long after one export the next may be taken, per shop. */
export const COOLDOWN_MS = Number(process.env.MM_EXPORT_COOLDOWN_MS || 10 * 60_000);

/** How many may be taken in one rolling day, per shop. */
export const DAILY_LIMIT = Number(process.env.MM_EXPORT_DAILY_LIMIT || 6);

/**
 * The ceiling on what one export may read, in uncompressed bytes.
 *
 * The same ceiling the control plane's own backups use, and for the same
 * reason: a shop that has outgrown this mechanism must fail early and cheaply
 * rather than after eight minutes and a function that ran out of memory.
 */
export const MAX_RAW_BYTES = Number(process.env.MM_BACKUP_MAX_RAW_BYTES || 512 * 1024 * 1024);

/** The audit row that both records the act and is the rate limiter's memory. */
const ENTITY_TYPE = 'data_export';
export const ACTION = 'EXPORT';

/** In-process, per shop: the double-click, stopped before it opens a read. */
const running = new Set();

/**
 * Refused because it is too soon, or because today has had enough.
 *
 * 429 with `Retry-After`, and the number of seconds is in `details` as well as
 * in the header — the screen has to be able to say "try again in 8 minutes" in
 * Arabic, and it cannot do that from an English sentence.
 */
export class ExportRateLimitedError extends AppError {
  constructor(retryAfterSeconds, reason) {
    super(
      `A copy of this shop's data was taken recently. The next one can be taken in `
      + `${Math.ceil(retryAfterSeconds / 60)} minute(s).`,
      {
        status: 429,
        code: 'EXPORT_RATE_LIMITED',
        details: { retryAfterSeconds, reason, limit: DAILY_LIMIT },
      },
    );
    this.retryAfter = retryAfterSeconds;
  }
}

const parse = (value) => {
  const ms = Date.parse(String(value || '').replace(' ', 'T'));
  return Number.isFinite(ms) ? ms : null;
};

/**
 * What the shop's audit log says about exports, which is all the rate limiter
 * knows and all it needs to know.
 *
 * One query, two facts: when the last one was asked for, and how many have been
 * asked for in the last day. Both are read from `audit_logs`, which is where
 * "who took a copy of the shop's whole book, and when" has to be recorded
 * anyway — so the limit and the record are the same rows, and there is no
 * second table that could disagree with the first.
 */
export async function usage() {
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const row = await getDb().prepare(`
    SELECT COUNT(*) AS n, MAX(created_at) AS last_at
      FROM audit_logs
     WHERE entity_type = ? AND action = ? AND created_at >= ?
  `).get(ENTITY_TYPE, ACTION, since);

  const lastAt = row?.last_at || null;
  const lastMs = parse(lastAt);
  const usedToday = Number(row?.n || 0);

  const waits = [];
  if (lastMs !== null) waits.push(lastMs + COOLDOWN_MS - Date.now());
  if (usedToday >= DAILY_LIMIT) {
    // The oldest of the ones that count still occupies its slot until it is a
    // day old; that is when the ceiling lifts.
    const oldest = await getDb().prepare(`
      SELECT MIN(created_at) AS at FROM (
        SELECT created_at FROM audit_logs
         WHERE entity_type = ? AND action = ? AND created_at >= ?
         ORDER BY created_at DESC LIMIT ?
      )
    `).get(ENTITY_TYPE, ACTION, since, DAILY_LIMIT);
    const oldestMs = parse(oldest?.at);
    if (oldestMs !== null) waits.push(oldestMs + 24 * 3_600_000 - Date.now());
  }

  const waitMs = Math.max(0, ...waits, 0);
  return {
    lastExportAt: lastAt,
    usedToday,
    dailyLimit: DAILY_LIMIT,
    cooldownSeconds: Math.round(COOLDOWN_MS / 1000),
    retryAfterSeconds: waitMs > 0 ? Math.ceil(waitMs / 1000) : 0,
    reason: waitMs > 0 && usedToday >= DAILY_LIMIT ? 'daily' : (waitMs > 0 ? 'cooldown' : null),
  };
}

/** What the Backups screen shows before anybody presses anything. */
export async function status() {
  const state = await usage();
  return {
    ...state,
    available: true,
    driver: driverName(),
    redacted: Object.entries(CREDENTIAL_COLUMNS)
      .flatMap(([table, columns]) => columns.map((column) => `${table}.${column}`)),
  };
}

/** `mm-accessories-data-2026-08-23-14-05.zip` — the shop's name, then when. */
function filenameFor(names, takenAt) {
  const slug = String(names.en || 'shop')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 40) || 'shop';
  return `${slug}-data-${takenAt.slice(0, 19).replace(/[:T]/g, '-')}.zip`;
}

/** The name the archive's own entries and manifest use for this shop. */
const archiveSlug = () => currentTenant()?.slug || 'shop';

/**
 * Decide whether this may happen, and record that it did — before a byte is
 * written.
 *
 * The audit row is written FIRST, deliberately. It is what the next request's
 * rate limit reads, so writing it after the archive was built would let a
 * second press slip past while the first was still reading the shop; and "who
 * asked for a copy of the whole book" is the security-relevant fact whether or
 * not the download finished.
 */
export async function begin(context = {}) {
  // Checked here as well as in `stream()`, so the second half of a double-click
  // is refused BEFORE it writes the audit row the rate limiter counts —
  // otherwise one press that never produced a file would spend a day's slot.
  // `stream()` still owns the lock: this is the cheap check, that is the true one.
  if (running.has(archiveSlug())) {
    throw new AppError('A copy of this shop\'s data is already being prepared.', {
      status: 409, code: 'EXPORT_IN_PROGRESS',
    });
  }

  const state = await usage();
  if (state.retryAfterSeconds > 0) {
    throw new ExportRateLimitedError(state.retryAfterSeconds, state.reason);
  }

  const settings = await repositories.settings.asObject();
  const names = companyNameFrom((key) => settings[key], currentTenant());
  const takenAt = new Date().toISOString();
  const filename = filenameFor(names, takenAt);

  await auditService.record({
    action: ACTION,
    module: 'settings',
    entityType: ENTITY_TYPE,
    entityLabel: filename,
    after: { takenAt, redacted: true },
    actor: context.actor,
    request: context.request,
  });

  return { takenAt, filename, names };
}

/**
 * Build the archive for this shop and hand it to `write`, chunk by chunk.
 *
 * One pass over the shop, inside one transaction (see `readSnapshot`): the
 * snapshot parts go straight into the archive as they are produced, and the
 * same rows feed the two workbooks on the way past. The shop is read once, not
 * twice, and this function's heap holds one part rather than one table.
 */
export async function stream({ takenAt, names, write, context = {} }) {
  const slug = archiveSlug();
  if (running.has(slug)) {
    throw new AppError('A copy of this shop\'s data is already being prepared.', {
      status: 409, code: 'EXPORT_IN_PROGRESS',
    });
  }
  running.add(slug);

  try {
    const installId = await shopInstallId();
    let totals = null;

    await assembleArchive({
      write,
      shop: { slug, nameEn: names.en, nameAr: names.ar },
      takenAt,
      redacted: Object.entries(CREDENTIAL_COLUMNS)
        .flatMap(([table, columns]) => columns.map((column) => `${table}.${column}`)),
      produce: async ({ addPart, handles, feed }) => {
        const snapshot = await readSnapshot({
          budget: MAX_RAW_BYTES,
          redact: CREDENTIAL_COLUMNS,
          onPart: (name, bytes) => addPart(name, bytes),
          onRows: (table, columns, rows) => {
            if (handles(table)) feed(table, columns, rows);
          },
        });
        totals = snapshot;

        // The same manifest the control plane writes, so the two archives are
        // the same object and `restore-shop.js --file` reads either one.
        return {
          format: 'mm-shop-snapshot',
          formatVersion: 1,
          takenAt,
          kind: 'shop_export',
          shop: {
            slug,
            tenantId: currentTenant()?.id ?? null,
            nameEn: names.en,
            nameAr: names.ar,
            installId,
            driver: driverName(),
          },
          app: { version: '1.0.0', controlPlane: config.platform.driver },
          tables: snapshot.tables,
          totals: { rows: snapshot.totalRows, rawBytes: snapshot.totalBytes },
          // Named in the file itself, not only in the README: whatever reads
          // this archive next has to be able to see what it does not carry.
          redacted: snapshot.redacted,
        };
      },
    });

    return { rows: totals.totalRows, tables: totals.tables.length };
  } catch (error) {
    // A second row, and only when it went wrong. The row written by `begin()`
    // is the one the rate limiter counts, so a success must not write another
    // one — it would count one export as two and halve the daily ceiling.
    await auditService.record({
      action: 'EXPORT_FAILED',
      module: 'settings',
      entityType: ENTITY_TYPE,
      entityLabel: 'failed',
      status: 'FAILURE',
      message: String(error.message || error).slice(0, 300),
      actor: context.actor,
      request: context.request,
    }).catch(() => {});
    throw error;
  } finally {
    running.delete(slug);
  }
}

export default {
  begin, stream, status, usage, COOLDOWN_MS, DAILY_LIMIT, ExportRateLimitedError,
  SnapshotTooLargeError,
};
