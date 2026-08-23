/**
 * The owner's own API: `/api/platform/*`. Its own cookie, its own auth
 * middleware, and its own session — nothing here is reachable with an ERP
 * login, and nothing here trusts one.
 *
 * Three kinds of route live in this file. The control-plane routes (tenants,
 * modules, limits, suspension, migrations) read and write the platform's own
 * database and never touch a shop's. The fleet routes (`/overview`,
 * `/tenants/:slug/report`, `/users`, `/roles`, the password reset) read *inside*
 * one shop at a time, and every one of them delegates to `FleetService`, which
 * does that work on that shop's own connection inside `runWithTenant`. No query
 * in either half names another shop's database, and none joins across two.
 *
 * The third kind is the backups, at the bottom. They are the most sensitive
 * routes on this platform — a backup is a shop's whole book — and their own
 * rules are written out where they are mounted.
 */
import { Router } from 'express';
import { z } from 'zod';
import config from '../../config/index.js';
import platformAuth from '../../platform/auth.js';
import tenantService from '../../platform/TenantService.js';
import fleetService from '../../platform/FleetService.js';
import fleetSummaries from '../../platform/FleetSummaryService.js';
import controlPlaneHealth from '../../platform/controlPlaneHealth.js';
import backupService from '../../platform/BackupService.js';
import turso from '../../platform/turso.js';
import integrations from '../../platform/integrations.js';
import { publicBaseUrl, tenantLinks } from '../../platform/links.js';
import { ownerLandingRouter } from './landing.js';
import { migrateAllTenants } from '../../platform/migrateAll.js';
import { asyncHandler } from '../middleware/index.js';
import { NotFoundError, ValidationError } from '../../shared/errors.js';
import { platformDb } from '../../platform/db.js';
import { deploymentInfo } from '../../shared/deploymentInfo.js';

const router = Router();

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: false, // offline LAN/localhost deployment, same as the ERP cookie
  maxAge: 12 * 60 * 60 * 1000,
};

const validateBody = (schema) => (req, _res, next) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    return next(new ValidationError(
      'Please correct the highlighted fields',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    ));
  }
  req.body = result.data;
  return next();
};

const loginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });

const setupSchema = z.object({
  password: z.string().min(8, 'Choose a password of at least 8 characters'),
  fullName: z.string().optional(),
});

/**
 * Drawn by the sign-in page before anyone has signed in, so it cannot require a
 * session. It says only whether an owner exists.
 */
/**
 * `deployment` is on this route and on `/auth/me` below, which between them are
 * the two calls the console makes at boot on every path: signed in, signed out,
 * and never-set-up. Whichever answers, the console knows which deployment it is
 * on before it draws anything — including on the sign-in screen, which is
 * exactly where somebody is about to type a password into the wrong one.
 */
router.get('/auth/state', asyncHandler(async (_req, res) => {
  res.json({ needsSetup: await platformAuth.needsSetup(), deployment: deploymentInfo() });
}));

/** Open exactly once, on a console that has no owner yet. */
router.post('/auth/setup', validateBody(setupSchema), asyncHandler(async (req, res) => {
  const result = await platformAuth.setup(req.body);
  res.cookie(platformAuth.COOKIE_NAME, result.token, cookieOptions);
  res.status(201).json(result);
}));

router.post('/auth/login', validateBody(loginSchema), asyncHandler(async (req, res) => {
  const result = await platformAuth.login(req.body);
  res.cookie(platformAuth.COOKIE_NAME, result.token, cookieOptions);
  res.json(result);
}));

router.post('/auth/logout', platformAuth.authenticate, asyncHandler(async (_req, res) => {
  res.clearCookie(platformAuth.COOKIE_NAME);
  res.json({ ok: true });
}));

router.get('/auth/me', platformAuth.authenticate, asyncHandler(async (req, res) => {
  res.json({ user: req.platformUser, deployment: deploymentInfo() });
}));

// Everything below is the owner's own dashboard, behind its own session.
router.use(platformAuth.authenticate);

/**
 * The marketing page's content. Mounted here rather than written out inline so
 * that the four owner routes and the two public ones live in one file together
 * — the whole point of the pair is that they are opposites (session vs none,
 * `no-store` vs a year), and that is only visible when they are read side by
 * side. Sitting below `authenticate`, they carry the owner session exactly as
 * every route below does.
 */
router.use('/landing', ownerLandingRouter);

const limitsSchema = z.object({
  maxUsers: z.number().int().min(0).optional(),
  maxProducts: z.number().int().min(0).optional(),
}).optional();

/**
 * Where the new tenant's data lives. Absent means `{ mode: 'file' }` — the
 * shop-PC default — so an older client that knows nothing about hosting keeps
 * working unchanged.
 *
 * `auto` carries nothing at all: the whole point is that the owner types a
 * shop name, and the URL and token are made on the server where the API token
 * lives. The token in `libsql` is accepted here and never travels the other
 * way: it is written to the control-plane row and `TenantService.toView`
 * reports only `hasAuthToken`.
 */
const databaseSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('auto') }),
  z.object({ mode: z.literal('file') }),
  z.object({
    mode: z.literal('libsql'),
    url: z.string().min(1),
    authToken: z.string().optional(),
  }),
]).optional();

const tenantCreateSchema = z.object({
  slug: z.string().min(2).max(31),
  nameEn: z.string().min(1),
  nameAr: z.string().min(1).optional(),
  modules: z.array(z.string()).optional(),
  limits: limitsSchema,
  websiteEnabled: z.boolean().optional(),
  database: databaseSchema,
});

const tenantUpdateSchema = z.object({
  nameEn: z.string().min(1).optional(),
  nameAr: z.string().min(1).optional(),
  modules: z.array(z.string()).optional(),
  limits: limitsSchema,
  websiteEnabled: z.boolean().optional(),
  notes: z.string().optional(),
});

/**
 * What kind of deployment this dashboard is talking to.
 *
 * The create form needs it to pick a sensible default: whether a file can work
 * at all here, and whether the server can make a database on its own.
 * `canProvision` is a yes or no — never the token, never the organisation, and
 * nothing about the control plane's own URL or credentials.
 *
 * Which DEPLOYMENT this is deliberately does not appear here, even though it is
 * not a secret. This route is fenced by a `deepEqual` in the tests precisely so
 * that nothing drifts into it, and the console already learns its environment
 * from `/auth/me` and `/auth/state` — before it has a session, which is where
 * it actually matters.
 */
router.get('/environment', asyncHandler(async (_req, res) => {
  res.json({
    hostedControlPlane: config.platform.driver === 'libsql',
    canProvision: await turso.canProvision(),
  });
}));

/* --------------------------------------------------------- integrations
 *
 * Turso, connected from the console rather than from a deploy setting.
 *
 * The rule for all three routes is the same and is worth stating once: the
 * platform API token goes in on the PUT and never comes out. Not from the GET,
 * not masked, not in an error message, not in the audit row the PUT writes.
 * There is nothing useful to show an owner about a token he cannot read back —
 * changing it means pasting a new one, which these routes verify exactly as
 * they verified the first.
 */

const tursoConnectSchema = z.object({
  apiToken: z.string().min(1, 'Paste the API token'),
  // Both optional on purpose: an owner should not have to know what an
  // organisation slug is. The server adopts the only one the token can see,
  // and asks — with the list — only when there is genuinely a choice.
  org: z.string().optional(),
  group: z.string().optional(),
});

router.get('/integrations/turso', asyncHandler(async (_req, res) => {
  res.json(await integrations.status());
}));

router.put('/integrations/turso', validateBody(tursoConnectSchema), asyncHandler(async (req, res) => {
  res.json(await integrations.connectTurso(req.body, req.platformUser));
}));

router.delete('/integrations/turso', asyncHandler(async (req, res) => {
  res.json(await integrations.disconnectTurso(req.platformUser));
}));

/**
 * The two links an owner hands out, on every tenant this router returns.
 *
 * Built from the address *this* request arrived at, so a deployment reached
 * through a proxy, a custom domain or a preview URL each hands back links that
 * work — which a browser concatenating `location.origin` could not promise.
 */
const withLinks = (req, tenant) => ({ ...tenant, links: tenantLinks(publicBaseUrl(req), tenant.slug) });

router.get('/tenants', asyncHandler(async (req, res) => {
  const rows = await tenantService.list();
  res.json({ rows: rows.map((row) => withLinks(req, row)) });
}));

router.get('/tenants/:slug', asyncHandler(async (req, res) => {
  res.json(withLinks(req, await tenantService.get(req.params.slug)));
}));

router.get('/tenants/:slug/stats', asyncHandler(async (req, res) => {
  res.json(await tenantService.stats(req.params.slug));
}));

router.post('/tenants', validateBody(tenantCreateSchema), asyncHandler(async (req, res) => {
  const created = await tenantService.create(req.body, req.platformUser);
  // The password is shown once; the links are what the owner needs after that
  // dialog closes, so they come back with it rather than being looked up.
  res.status(201).json(withLinks(req, created));
}));

router.put('/tenants/:slug', validateBody(tenantUpdateSchema), asyncHandler(async (req, res) => {
  res.json(withLinks(req, await tenantService.update(req.params.slug, req.body, req.platformUser)));
}));

router.post('/tenants/:slug/suspend', asyncHandler(async (req, res) => {
  res.json(withLinks(req, await tenantService.suspend(req.params.slug, req.platformUser)));
}));

router.post('/tenants/:slug/resume', asyncHandler(async (req, res) => {
  res.json(withLinks(req, await tenantService.resume(req.params.slug, req.platformUser)));
}));

router.post('/tenants/:slug/reset-admin-password', asyncHandler(async (req, res) => {
  res.json(await tenantService.resetAdminPassword(req.params.slug, req.platformUser));
}));

/* ---------------------------------------------------------------- the fleet
 *
 * Everything below reads inside one shop's own database. The work is done in
 * `FleetService` so that this file stays a routing table: what a number means
 * belongs next to the SQL that produces it, not next to the URL.
 */

/**
 * The landing page: the whole fleet in one response, read from one table.
 *
 * Every figure comes from `tenant_summaries` and every DECISION — status, the
 * website switch, modules, limits, the shop counts — is read live from
 * `tenants` on the same query. That is what makes this one database read at six
 * shops and one database read at eight hundred, instead of one connection per
 * shop per page load. `platform/FleetSummaryService.js` writes down why each
 * side of that split is where it is.
 *
 * A shop whose database cannot be read comes back as one row with `error: true`
 * and its last good figures beside the moment the read failed; a shop that has
 * never been measured comes back with nulls and `measured: false`. Neither is
 * ever a zero, and the page renders for both.
 *
 * `?live=1` is the escape hatch: the original fan-out, opening every shop, for
 * the day somebody does not believe the summaries. It is not what the console
 * loads, and it is deliberately not the default — at eighty shops it is eighty
 * connections.
 */
router.get('/overview', asyncHandler(async (req, res) => {
  if (String(req.query.live || '') === '1') {
    const readAt = new Date().toISOString();
    const live = await fleetService.overviewLive();
    /**
     * Dressed in the same clothes as a summary read, because the console draws
     * one screen: every shop it could read WAS just measured, so it says so,
     * and a shop it could not is flagged exactly as the summary path flags one.
     */
    return res.json({
      ...live,
      shops: live.shops.map((shop) => ({
        ...shop,
        measured: !shop.error,
        summaryAt: shop.error ? null : readAt,
        summaryAgeMs: shop.error ? null : 0,
        summarySource: 'console',
        stale: false,
      })),
      totals: {
        ...live.totals,
        measuredShops: live.shops.filter((s) => !s.error).length,
        unmeasuredShops: 0,
        staleShops: 0,
        unreachableShops: live.shops.filter((s) => s.error).length,
        todayShops: live.shops.filter((s) => !s.error).length,
      },
      summary: {
        source: 'live', readAt, newestAt: readAt, oldestAt: readAt,
        staleAfterMs: fleetSummaries.STALE_MS, backfilled: 0,
      },
    });
  }
  return res.json(await fleetSummaries.overview());
}));

/**
 * What the console needs to explain the figures it is showing: whether the
 * sweep that writes them is switched on at all, and how old the oldest is.
 */
router.get('/summaries', asyncHandler(async (_req, res) => {
  const data = await fleetSummaries.overview({ backfill: false });
  res.json({
    /**
     * Same signal the backups screen already uses: a deployment with no
     * CRON_SECRET takes no scheduled anything, and a console that did not say
     * so would be a console quietly showing older and older numbers.
     */
    scheduleArmed: Boolean(process.env.CRON_SECRET),
    ...data.summary,
    shops: data.shops.map((shop) => ({
      slug: shop.slug,
      measured: shop.measured,
      summaryAt: shop.summaryAt,
      summaryAgeMs: shop.summaryAgeMs,
      summarySource: shop.summarySource,
      stale: shop.stale,
      error: shop.error,
    })),
  });
}));

/**
 * Rebuild the summaries by opening every shop — the fan-out, on purpose,
 * because somebody pressed a button.
 *
 * Audited for exactly that reason: it is the one console action that reaches
 * into every shop's database at once, and "who made the console open eighty
 * databases at 3pm" should have an answer. The body is the freshly written
 * overview, so the page redraws from what was just measured.
 */
router.post('/overview/refresh', asyncHandler(async (req, res) => {
  const result = await fleetSummaries.refreshFleet({ source: 'console' });
  await platformDb().prepare(`
    INSERT INTO platform_audit (platform_user_id, tenant_id, action, detail, created_at)
    VALUES (?, NULL, 'FLEET_SUMMARY_REFRESH', ?, ?)
  `).run(req.platformUser?.id ?? null, JSON.stringify(result), new Date().toISOString());
  res.json({ ...result, overview: await fleetSummaries.overview({ backfill: false }) });
}));

/** The same, for one shop — what the shop's own screen refreshes. */
router.post('/tenants/:slug/summary/refresh', asyncHandler(async (req, res) => {
  const result = await fleetSummaries.refreshFleet({ slugs: [req.params.slug], source: 'console' });
  if (!result.refreshed) throw new NotFoundError('Tenant', req.params.slug);
  res.json(result);
}));

/**
 * Whether this instance is answering from the control plane or from memory.
 *
 * The owner's view of what `/api/health` reports publicly: the same state plus
 * the class of the last failure and how many reads it has taken. Never a slug's
 * database URL, never a driver's message — see controlPlaneHealth.js.
 */
router.get('/control-plane', asyncHandler(async (_req, res) => {
  res.json(controlPlaneHealth.ownerSnapshot());
}));

/**
 * One shop, in depth. `days` is clamped server-side — the console never decides
 * how much work the server will do.
 */
router.get('/tenants/:slug/report', asyncHandler(async (req, res) => {
  res.json(await fleetService.report(req.params.slug, { days: req.query.days }));
}));

router.get('/tenants/:slug/users', asyncHandler(async (req, res) => {
  res.json(await fleetService.users(req.params.slug));
}));

router.get('/tenants/:slug/roles', asyncHandler(async (req, res) => {
  res.json(await fleetService.roles(req.params.slug));
}));

/**
 * A one-time password for one member of that shop's staff, shown to the owner
 * once and stored nowhere in the clear. The shop's own login accepts it, and
 * `must_change_password` makes sure it is the last time it is used.
 */
router.post('/tenants/:slug/users/:id/reset-password', asyncHandler(async (req, res) => {
  const result = await fleetService.resetUserPassword(req.params.slug, req.params.id, req.platformUser);
  res.json(result);
}));

router.post('/migrate', asyncHandler(async (_req, res) => {
  res.json({ rows: await migrateAllTenants() });
}));

/* --------------------------------------------------------------- backups
 *
 * A backup is a shop's whole book: every price, every cost, every customer's
 * phone number and what every employee is paid. So these routes are the most
 * sensitive on the platform, and the rules for them are stricter than for
 * anything else in this file:
 *
 *  - They sit below `platformAuth.authenticate`, so an ERP session — even a
 *    shop administrator's — cannot reach any of them. Only the owner's console
 *    cookie does.
 *  - Every one is scoped by `:slug` and resolves the backup by
 *    (id AND tenant_id), so naming another shop's backup id under this shop's
 *    slug returns 404 rather than somebody else's data.
 *  - The BYTES are never behind a plain GET with a cookie. Downloading is two
 *    steps: a POST that mints a single-use ticket good for two minutes, and a
 *    GET that spends it. A link pasted into a chat, an <img> on a hostile page
 *    or a stale entry in a browser's history is worth nothing on its own,
 *    because the GET still needs the owner's session as well as the ticket.
 *  - Restoring is three steps and is described where it is implemented.
 */

router.get('/backups', asyncHandler(async (_req, res) => {
  res.json(await backupService.fleetStatus());
}));

router.get('/tenants/:slug/backups', asyncHandler(async (req, res) => {
  res.json(await backupService.list(req.params.slug));
}));

router.post('/tenants/:slug/backups', asyncHandler(async (req, res) => {
  res.status(201).json(await backupService.take(req.params.slug, {
    kind: 'manual', actor: req.platformUser,
  }));
}));

/** Step one of a download: a ticket, and the filename the browser should use. */
router.post('/tenants/:slug/backups/:id/download-ticket', asyncHandler(async (req, res) => {
  res.json(await backupService.downloadTicket(req.params.slug, req.params.id, req.platformUser));
}));

/**
 * Step two: the file itself, assembled on the way out.
 *
 * The stored snapshot is read a part at a time and written straight into the
 * response, and the two workbooks are built from those same parts as they go
 * past — so the archive is streamed rather than assembled in memory, and this
 * function's heap holds one part and one workbook rather than a whole shop.
 * See `BackupService.buildDownload` for why the workbooks are made here rather
 * than kept.
 *
 * No `Content-Length`, because the finished size is not known until the last
 * byte is written: the browser gets a spinner instead of a percentage, which is
 * the price of not holding a shop's whole book in memory to count it first.
 * Back-pressure IS respected — a slow connection slows the build rather than
 * filling a buffer.
 */
router.get('/backups/download/:token', asyncHandler(async (req, res) => {
  const backup = await backupService.claimDownload(req.params.token, req.platformUser);
  const filename = `${backup.slug}-backup-${backup.taken_at.slice(0, 19).replace(/[:T]/g, '-')}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  await backupService.buildDownload(backup, async (chunk) => {
    if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
  });
  res.end();
}));

/**
 * Restore, step one: what would happen. Nothing is touched, and the answer
 * carries a ticket that names this backup and this shop and expires in five
 * minutes. See `BackupService.planRestore`.
 */
router.post('/tenants/:slug/backups/:id/restore-plan', asyncHandler(async (req, res) => {
  res.json(await backupService.planRestore(req.params.slug, req.params.id, req.platformUser));
}));

const restoreSchema = z.object({
  ticket: z.string().min(1),
  // Typed by hand into the dialog. The ticket proves a plan was seen; this
  // proves which shop the person believed they were looking at.
  confirmSlug: z.string().min(1),
});

router.post('/tenants/:slug/backups/restore', validateBody(restoreSchema), asyncHandler(async (req, res) => {
  res.json(await backupService.restore(req.params.slug, {
    ticket: req.body.ticket,
    confirmSlug: req.body.confirmSlug,
    actor: req.platformUser,
  }));
}));

export default router;
