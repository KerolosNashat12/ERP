/**
 * The owner's own API: `/api/platform/*`. Its own cookie, its own auth
 * middleware, and — deliberately — no import of anything that touches a
 * tenant's data. Everything here reads and writes the control plane only.
 */
import { Router } from 'express';
import { z } from 'zod';
import platformAuth from '../../platform/auth.js';
import tenantService from '../../platform/TenantService.js';
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

const tenantCreateSchema = z.object({
  slug: z.string().min(2).max(31),
  nameEn: z.string().min(1),
  nameAr: z.string().min(1).optional(),
  modules: z.array(z.string()).optional(),
  limits: limitsSchema,
  websiteEnabled: z.boolean().optional(),
});

const tenantUpdateSchema = z.object({
  nameEn: z.string().min(1).optional(),
  nameAr: z.string().min(1).optional(),
  modules: z.array(z.string()).optional(),
  limits: limitsSchema,
  websiteEnabled: z.boolean().optional(),
  notes: z.string().optional(),
});

router.get('/tenants', asyncHandler(async (_req, res) => {
  res.json({ rows: await tenantService.list() });
}));

router.get('/tenants/:slug', asyncHandler(async (req, res) => {
  res.json(await tenantService.get(req.params.slug));
}));

router.get('/tenants/:slug/stats', asyncHandler(async (req, res) => {
  res.json(await tenantService.stats(req.params.slug));
}));

router.post('/tenants', validateBody(tenantCreateSchema), asyncHandler(async (req, res) => {
  res.status(201).json(await tenantService.create(req.body, req.platformUser));
}));

router.put('/tenants/:slug', validateBody(tenantUpdateSchema), asyncHandler(async (req, res) => {
  res.json(await tenantService.update(req.params.slug, req.body, req.platformUser));
}));

router.post('/tenants/:slug/suspend', asyncHandler(async (req, res) => {
  res.json(await tenantService.suspend(req.params.slug, req.platformUser));
}));

router.post('/tenants/:slug/resume', asyncHandler(async (req, res) => {
  res.json(await tenantService.resume(req.params.slug, req.platformUser));
}));

router.post('/tenants/:slug/reset-admin-password', asyncHandler(async (req, res) => {
  res.json(await tenantService.resetAdminPassword(req.params.slug, req.platformUser));
}));

router.post('/migrate', asyncHandler(async (_req, res) => {
  res.json({ rows: await migrateAllTenants() });
}));

export default router;
