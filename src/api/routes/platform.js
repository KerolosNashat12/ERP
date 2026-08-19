/**
 * The owner's own API: `/api/platform/*`. Its own cookie, its own auth
 * middleware, and its own session — nothing here is reachable with an ERP
 * login, and nothing here trusts one.
 *
 * Two kinds of route live in this file. The control-plane routes (tenants,
 * modules, limits, suspension, migrations) read and write the platform's own
 * database and never touch a shop's. The fleet routes (`/overview`,
 * `/tenants/:slug/report`, `/users`, `/roles`, the password reset) read *inside*
 * one shop at a time, and every one of them delegates to `FleetService`, which
 * does that work on that shop's own connection inside `runWithTenant`. No query
 * in either half names another shop's database, and none joins across two.
 */
import { Router } from 'express';
import { z } from 'zod';
import config from '../../config/index.js';
import platformAuth from '../../platform/auth.js';
import tenantService from '../../platform/TenantService.js';
import fleetService from '../../platform/FleetService.js';
import turso from '../../platform/turso.js';
import { publicBaseUrl, tenantLinks } from '../../platform/links.js';
import { migrateAllTenants } from '../../platform/migrateAll.js';
import { asyncHandler } from '../middleware/index.js';
import { ValidationError } from '../../shared/errors.js';

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
router.get('/auth/state', asyncHandler(async (_req, res) => {
  res.json({ needsSetup: await platformAuth.needsSetup() });
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
  res.json({ user: req.platformUser });
}));

// Everything below is the owner's own dashboard, behind its own session.
router.use(platformAuth.authenticate);

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
 */
router.get('/environment', asyncHandler(async (_req, res) => {
  res.json({
    hostedControlPlane: config.platform.driver === 'libsql',
    canProvision: turso.canProvision(),
  });
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
 * The landing page: the whole fleet in one response.
 *
 * A shop whose database cannot be read comes back as one row with `error: true`
 * and null figures — the page renders, the owner sees which shop is unreachable,
 * and no other shop's numbers are lost to it.
 */
router.get('/overview', asyncHandler(async (_req, res) => {
  res.json(await fleetService.overview());
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

export default router;
