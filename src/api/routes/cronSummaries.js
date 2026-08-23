/**
 * The scheduled job that keeps the owner's console honest: `/api/cron/summaries`.
 *
 * The overview is read from `tenant_summaries` rather than computed by opening
 * every shop (see `platform/FleetSummaryService.js`). Something still has to
 * write those rows, and this is the writer that reaches every shop — including
 * the quiet one nobody has visited and nobody has opened in the console, which
 * is exactly the shop whose figures would otherwise be a year old.
 *
 * ── Why its own path and not a job inside the backup cron ────────────────────
 * Different cost and different cadence. A backup reads a shop's whole book and
 * runs twice a day; a summary is eight aggregate queries and wants to run every
 * hour. Bolting one to the other would mean either backing up hourly or letting
 * the console's figures go twelve hours stale, and neither is a trade anybody
 * asked for. It is also the same separation the backup cron already argues for
 * itself: one caller, one right, one thing that can fail.
 *
 * ── Same guards as the backup cron, for the same reasons ─────────────────────
 * `CRON_SECRET` only, compared without a fast exit; a budget, because a function
 * has a time limit and a fleet has a length; and staleness order, so a fleet too
 * large for one invocation still makes progress every run and never starves one
 * shop the way an alphabetical sweep would.
 *
 * ── If this never runs ───────────────────────────────────────────────────────
 * A deployment with no `CRON_SECRET` is not left with a console full of
 * year-old numbers. Two other writers cover it — a shop's own traffic refreshes
 * a summary that has gone stale, and the console backfills a shop that has none
 * — and every figure on the screen carries the moment it was read, so an owner
 * can see that nothing is refreshing them. `GET /api/platform/summaries` says
 * `scheduleArmed: false` outright.
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import summaries from '../../platform/FleetSummaryService.js';
import { asyncHandler } from '../middleware/index.js';

const router = Router();

/** How long one invocation may spend, and how many shops it may touch. */
const BUDGET_MS = Number(process.env.MM_SUMMARY_CRON_BUDGET_MS || 40_000);
const MAX_SHOPS = Number(process.env.MM_SUMMARY_CRON_MAX_SHOPS || 200);

/**
 * Fresher than this and a shop is skipped. Below the hourly schedule so a run
 * that starts a minute early still does its work, and well below the three
 * hours at which the console starts calling a figure stale.
 */
const MIN_AGE_MS = Number(process.env.MM_SUMMARY_MIN_AGE_MS || 45 * 60_000);

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

router.post('/summaries', asyncHandler(runSweep));
// Vercel's scheduler issues a GET. Both are accepted so the job can also be
// kicked by hand with curl, which is how an owner checks it works.
router.get('/summaries', asyncHandler(runSweep));

async function runSweep(req, res) {
  if (!process.env.CRON_SECRET) {
    return res.status(503).json({
      error: {
        code: 'CRON_NOT_ARMED',
        message: 'The fleet summary sweep is not switched on: this deployment has no CRON_SECRET. '
          + 'Add it to the project\'s environment variables and redeploy.',
      },
    });
  }
  if (!authorised(req)) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Not authorised' } });
  }

  const started = Date.now();
  /**
   * Worst first: a shop with no summary at all, then the oldest good read.
   * Suspended shops are included on purpose — unlike a backup, reading one is
   * cheap, and a suspended shop's figures are exactly what the conversation
   * about why it is suspended needs. `FleetService` makes the same choice.
   */
  const rows = await summaries.staleShops({ olderThanMs: MIN_AGE_MS, limit: MAX_SHOPS });

  const done = [];
  let remaining = 0;
  for (let i = 0; i < rows.length; i += 1) {
    if (Date.now() - started > BUDGET_MS) { remaining = rows.length - i; break; }
    done.push(await summaries.refreshShop(rows[i], { source: 'cron' }));
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
