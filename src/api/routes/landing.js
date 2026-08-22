/**
 * The six routes the landing page's content is read and written through.
 *
 * Two routers, because they belong to two different worlds and must never be
 * confused for one another:
 *
 *   `publicLandingRouter`  — mounted at `/api/landing` in `server.js`, in BOTH
 *                            builds. No session, no tenant, no control plane
 *                            required. A single-shop deployment has no control
 *                            plane at all, and answers the empty document —
 *                            which is exactly right, because the page's own
 *                            defaults are the page.
 *   `ownerLandingRouter`   — mounted at `/api/platform/landing`, INSIDE the
 *                            authenticated half of `platform.js`, so it
 *                            inherits the owner session the same way every
 *                            other console route does.
 *
 * Caching is the interesting part and the two halves are opposites:
 *
 *   - The document is `no-store`. The owner saving in one tab and refreshing
 *     the page in another is the entire point of this feature, and this
 *     deployment has been bitten before by a cached API answer outliving the
 *     truth (see the `no-store` block in `server.js` and the TTL comment in
 *     `middleware/tenant.js`). The `/api` middleware already sets it; it is set
 *     again here, deliberately, so the guarantee survives this router being
 *     mounted somewhere else one day.
 *   - The bytes are cached for a year — but only at the versioned URL. A slot's
 *     address never changes, so `?v=` carries the version instead, minted by
 *     the server into the document. A request that arrives with the current
 *     `v` gets `immutable`; a request without one, or with a stale one, gets a
 *     minute and an ETag, so a hand-typed URL can never pin a replaced logo in
 *     a CDN for a year.
 */
import { Router } from 'express';
import { asyncHandler, sendImage } from '../middleware/index.js';
import landing, { assetVersionTag, normaliseSlot } from '../../platform/LandingContentService.js';
import { NotFoundError, ValidationError } from '../../shared/errors.js';

export const publicLandingRouter = Router();

/**
 * The document, for the page. Never authenticated, never cached, never 500:
 * `publicDocument()` answers the empty document for a missing control plane, a
 * missing table, unreadable JSON or a document that fails validation.
 */
publicLandingRouter.get('/', asyncHandler(async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.json(await landing.publicDocument());
}));

/**
 * One slot's bytes. 404 when the slot is empty — and the same 404 when the slot
 * name is not one this page has a place for, because which slot names exist is
 * not something a public endpoint owes the internet an answer about.
 */
publicLandingRouter.get('/asset/:slot', asyncHandler(async (req, res) => {
  const slot = normaliseSlot(req.params.slot);
  const image = slot ? await landing.assetBytes(slot) : null;
  if (!image) throw new NotFoundError('Landing image', req.params.slot);

  // The `/api` guard above set `Pragma: no-cache` for every answer under this
  // prefix. On a JSON answer that is the point; on immutable bytes it is a
  // contradiction that some intermediaries resolve by not caching at all.
  res.removeHeader('Pragma');

  const current = assetVersionTag(image);
  const versioned = String(req.query.v || '') === current;
  sendImage(req, res, { ...image, created_at: image.updated_at }, {
    cacheControl: versioned
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=60, must-revalidate',
  });
}));

export const ownerLandingRouter = Router();

/** The stored document, plus where the defaults it merges onto come from. */
ownerLandingRouter.get('/', asyncHandler(async (_req, res) => {
  res.json(await landing.ownerView());
}));

/**
 * The whole document, validated and audited. The body IS the document — there
 * is no envelope, so the console can PUT back what `GET /api/landing` gave it.
 */
ownerLandingRouter.put('/', asyncHandler(async (req, res) => {
  res.json(await landing.save(req.body, req.platformUser));
}));

/**
 * An upload, as a base64 data URL in `data` — the same shape the ERP's own
 * image uploads use, so the console reuses the file-reading code it already
 * has. What the browser calls the file and what the data URL claims are both
 * ignored: the type is sniffed from the bytes.
 */
ownerLandingRouter.post('/asset/:slot', asyncHandler(async (req, res) => {
  const dataUrl = req.body?.data ?? req.body?.dataUrl ?? req.body?.image;
  if (typeof dataUrl !== 'string' || !dataUrl) {
    throw new ValidationError('Send the picture as a base64 data URL in "data"');
  }
  res.json(await landing.setAsset(req.params.slot, dataUrl, req.platformUser));
}));

/** Revert to the picture that ships in the repository. */
ownerLandingRouter.delete('/asset/:slot', asyncHandler(async (req, res) => {
  res.json(await landing.clearAsset(req.params.slot, req.platformUser));
}));

export default publicLandingRouter;
