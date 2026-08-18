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
import { NotFoundError } from '../../shared/errors.js';

const router = Router();

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

router.get('/products', asyncHandler(async (req, res) => {
  res.json(await storefront.products({
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

export default router;
