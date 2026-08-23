/**
 * The scheduled job: `/api/cron/backups`.
 *
 * The manual button matters less than this does. The shop that needs a backup
 * is the one nobody thought about, and nobody presses a button for a shop they
 * are not thinking about — so the automatic run is the feature and the button
 * is a convenience.
 *
 * ── Why a URL and not a worker ───────────────────────────────────────────────
 * Vercel's scheduler calls an HTTP path (`vercel.json` → `crons`). There is no
 * process to run a timer in: between requests this deployment does not exist.
 *
 * ── Who may call it ──────────────────────────────────────────────────────────
 * Only something holding `CRON_SECRET`, which Vercel sends as a bearer token on
 * every scheduled invocation. Deliberately NOT the owner's console session:
 * this is a different caller with a different right, and mixing them would mean
 * a leaked cron secret could read a console.
 *
 * With no `CRON_SECRET` set the route refuses everything and says so. That is
 * the safe failure, and it is not a silent one — `GET /api/platform/backups`
 * reports `scheduleArmed: false`, and the console shows the fleet a banner
 * saying automatic backups are not switched on. A deployment quietly taking no
 * backups is exactly the state this whole feature exists to make impossible.
 *
 * ── The budget ───────────────────────────────────────────────────────────────
 * A function has a time limit and a fleet has a length. Shops are taken in
 * staleness order — the one that has gone longest without a good backup first —
 * until the budget is spent, and whatever is left is first in line on the next
 * run. So a fleet too large for one invocation still makes progress every time
 * and never starves one shop, which a fixed alphabetical sweep would.
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import { platformDb } from '../../platform/db.js';
import backupService from '../../platform/BackupService.js';
import { asyncHandler } from '../middleware/index.js';

const router = Router();

/** How long one invocation may spend, and how many shops it may touch. */
const BUDGET_MS = Number(process.env.MM_BACKUP_CRON_BUDGET_MS || 45_000);
const MAX_SHOPS = Number(process.env.MM_BACKUP_CRON_MAX_SHOPS || 40);

/** Fresher than this and a shop is skipped — two runs a day must not make two. */
const MIN_AGE_HOURS = Number(process.env.MM_BACKUP_MIN_AGE_HOURS || 20);

/** Compared without a fast exit, so a wrong guess learns nothing from timing. */
function secretMatches(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected || ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function authorised(req) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return false;
  const header = String(req.get('authorization') || '');
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  return secretMatches(bearer, secret);
}

router.post('/backups', asyncHandler(runScheduledBackups));
// Vercel's scheduler issues a GET. Both are accepted so the job can also be
// kicked by hand with curl, which is how an owner checks it works.
router.get('/backups', asyncHandler(runScheduledBackups));

async function runScheduledBackups(req, res) {
  if (!process.env.CRON_SECRET) {
    return res.status(503).json({
      error: {
        code: 'CRON_NOT_ARMED',
        message: 'Automatic backups are not switched on: this deployment has no CRON_SECRET. '
          + 'Add it to the project\'s environment variables and redeploy.',
      },
    });
  }
  if (!authorised(req)) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Not authorised' } });
  }

  const started = Date.now();
  const cutoff = new Date(Date.now() - MIN_AGE_HOURS * 3_600_000).toISOString();

  /**
   * Active shops, oldest good backup first, and a shop that has never had one
   * ahead of every shop that has. Suspended shops are skipped for the same
   * reason the fleet migration skips them: a shop that is not trading is not
   * losing data, and reading its database is work with no purpose.
   */
  const rows = await platformDb().prepare(`
    SELECT t.slug AS slug,
           MAX(CASE WHEN b.status = 'ready' THEN b.taken_at END) AS last_ready
      FROM tenants t
      LEFT JOIN tenant_backups b ON b.tenant_id = t.id
     WHERE t.status = 'active'
     GROUP BY t.id, t.slug
    HAVING last_ready IS NULL OR last_ready < ?
     ORDER BY (last_ready IS NOT NULL), last_ready
     LIMIT ?
  `).all(cutoff, MAX_SHOPS);

  const done = [];
  let remaining = 0;

  for (let i = 0; i < rows.length; i += 1) {
    if (Date.now() - started > BUDGET_MS) {
      remaining = rows.length - i;
      break;
    }
    const { slug } = rows[i];
    try {
      const backup = await backupService.take(slug, { kind: 'scheduled' });
      done.push({
        slug, ok: true, id: backup.id, bytes: backup.byteSize, rows: backup.rowCount,
      });
    } catch (error) {
      /**
       * One shop failing is a fact about that shop, not a failure of the run.
       * The next shop still gets its backup, and the failure is already a
       * `failed` row that the console shows in red — which is the whole point
       * of recording failures rather than only successes.
       */
      done.push({ slug, ok: false, error: String(error.message || error).slice(0, 300) });
    }
  }

  return res.json({
    ran: done.length,
    ok: done.filter((d) => d.ok).length,
    failed: done.filter((d) => !d.ok).length,
    remaining,
    elapsedMs: Date.now() - started,
    shops: done,
  });
}

export default router;
