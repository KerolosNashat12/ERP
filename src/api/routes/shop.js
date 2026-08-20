/**
 * The public storefront API.
 *
 * Everything here is unauthenticated and readable by anyone on the internet, so
 * it is kept in its own router backed by its own service with hand-written SQL.
 * It deliberately does NOT reuse the ERP services: those select whole rows, and
 * one day somebody adds a column called `base_cost` to a shared query and the
 * shop's margins are on the public web. Narrow, boring, explicit is the point.
 */
import { Router } from 'express';
import { asyncHandler, sendImage } from '../middleware/index.js';
import storefront from '../../services/StorefrontService.js';
import images from '../../services/ImageService.js';
import webAssets from '../../services/WebAssetService.js';
import { currentTenant } from '../../infrastructure/database/connection.js';
import { confirmTenant } from '../middleware/tenant.js';
import { NotFoundError } from '../../shared/errors.js';

const router = Router();

/**
 * A tenant that has switched its website off must not leak that a shop even
 * exists there — so this is a plain 404, the same shape `notFoundHandler`
 * would produce, not a 403 that would confirm something is behind the door.
 * Registered first, ahead of every route below, so nothing here is ever
 * reachable while the switch is off. With no tenant resolved (the
 * single-shop build), `currentTenant()` is null and nothing changes.
 */
router.use(async (req, res, next) => {
  const tenant = currentTenant();
  if (!tenant || tenant.websiteEnabled) return next();

  // Before closing a storefront, ask the control plane again. This instance's
  // cached row may have been written by another one — and a shop that is open
  // being told it is closed, in front of its customers, is the one failure this
  // gate must never produce. Only a refusal that survives a fresh read stands.
  try {
    const confirmed = await confirmTenant(tenant.slug);
    if (confirmed && confirmed.websiteEnabled) {
      tenant.websiteEnabled = true;
      return next();
    }
  } catch {
    // The control plane being unreachable is not a reason to open a door the
    // owner closed; fall through to the 404 below.
  }

  return res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` } });
});

/** Shop-wide settings, categories and brands the pages need on first paint. */
router.get('/config', asyncHandler(async (_req, res) => {
  res.json(await storefront.config());
}));

router.get('/home', asyncHandler(async (_req, res) => {
  res.json(await storefront.home());
}));

router.get('/categories', asyncHandler(async (_req, res) => {
  res.json({ rows: await storefront.categories() });
}));

router.get('/brands', asyncHandler(async (_req, res) => {
  res.json({ rows: await storefront.brands() });
}));

/**
 * The catalogue listing, and — with `?ids=` — the favourites lookup.
 *
 * `ids` is a comma-separated list of product ids (`?ids=12,7,40`) and it takes
 * PRECEDENCE over every other parameter: `category`, `brand`, `q`, `sort`,
 * `page` and `pageSize` are ignored when it is present. The caller has named
 * the exact products it wants, in the exact order it wants them back, so there
 * is nothing left for a filter or a sort to do.
 *
 * Precedence is decided by PRESENCE, not by content. `?ids=` with nothing after
 * it, and `?ids=nonsense`, both mean "these products, of which there are none" and
 * answer with an empty page — not with the whole catalogue. A favourites page
 * whose stored list arrived unreadable must show the customer an empty shelf,
 * never every product in the shop relabelled as theirs.
 *
 * The service keeps the caller's order, drops ids that no longer resolve to a
 * published product, ignores anything that is not a plain number, and caps the
 * list. Nothing here validates: an unparseable id is not a bad request from a
 * customer, it is an old entry in somebody's localStorage.
 */
router.get('/products', asyncHandler(async (req, res) => {
  res.json(await storefront.products({
    ids: req.query.ids,
    category: req.query.category,
    brand: req.query.brand,
    q: req.query.q,
    sort: req.query.sort,
    page: req.query.page,
    pageSize: req.query.pageSize,
  }));
}));

router.get('/products/:id', asyncHandler(async (req, res) => {
  res.json(await storefront.product(Number(req.params.id)));
}));

/**
 * Photo bytes — the one public endpoint that answers with something other than
 * JSON. It cannot require a session: every `<img>` on the storefront points at
 * it, and a shop nobody has signed into is the normal case.
 *
 * `publishedBytes` refuses anything belonging to an unpublished product. Ids
 * are sequential, so without that gate next season's range would be one
 * incrementing counter away from public the day it is photographed. It is a
 * 404, not a 403: whether the id exists at all is not the internet's business.
 *
 * This is the one ERP service the storefront reuses. It is allowed because the
 * method is narrow by construction — five columns, and the publish check is
 * inside the query rather than in this router, where a later edit could lose it.
 */
router.get('/images/:id', asyncHandler(async (req, res) => {
  const image = await images.publishedBytes(req.params.id);
  if (!image) throw new NotFoundError('Image', req.params.id);
  sendImage(req, res, image);
}));

/**
 * The hero banner. Short cache — 5 minutes, not the year that product photos
 * get — because unlike a product photo this is one image an owner may swap on
 * a whim, and there is no new id to bust a long-lived cache with.
 *
 * WebAssetService is the same kind of narrow exception as ImageService above:
 * one column list, no publish gate to forget because there is nothing to gate
 * — a website asset has no draft state, it is either set or it is not.
 */
router.get('/banner', asyncHandler(async (req, res) => {
  const image = await webAssets.bytes('banner');
  if (!image) throw new NotFoundError('Banner image', 'banner');
  sendImage(req, res, { ...image, created_at: image.updated_at }, { cacheControl: 'public, max-age=300' });
}));

/**
 * The shop's logo — the same slot mechanism as the banner above, and the same
 * cache rules for the same reason: one URL that never changes, so it may not
 * be `immutable`, and the ETag carries `updated_at` so a replaced logo is
 * fetched again within five minutes rather than after a year.
 *
 * A 404 here is the normal case, not an error: most shops have not uploaded
 * one, and `/config` already told the client so (`branding.logo` is null and
 * `branding.monogram` is what to draw instead). The bytes are served with the
 * content type sniffed at upload, so a PNG logo keeps its transparency —
 * nothing in this path re-encodes anything.
 */
router.get('/logo', asyncHandler(async (req, res) => {
  const image = await webAssets.bytes('logo');
  if (!image) throw new NotFoundError('Logo image', 'logo');
  sendImage(req, res, { ...image, created_at: image.updated_at }, { cacheControl: 'public, max-age=300' });
}));

export default router;
