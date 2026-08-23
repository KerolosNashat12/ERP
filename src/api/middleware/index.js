/** Cross-cutting HTTP concerns: auth, RBAC, request context, error mapping. */
import config from '../../config/index.js';
import authService from '../../services/AuthService.js';
import repositories from '../../infrastructure/repositories/index.js';
import { currentTenant } from '../../infrastructure/database/connection.js';
import { AppError, ForbiddenError, UnauthorizedError, ValidationError } from '../../shared/errors.js';

/** Extracts the JWT from the httpOnly cookie or an Authorization header. */
function readToken(req) {
  if (req.cookies?.[config.auth.cookieName]) return req.cookies[config.auth.cookieName];
  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return null;
}

export function attachRequestContext(req, _res, next) {
  req.context = {
    actor: null,
    request: {
      ip: req.ip || req.socket?.remoteAddress || null,
      userAgent: req.get('user-agent') || null,
    },
  };
  next();
}

export async function authenticate(req, _res, next) {
  try {
    const token = readToken(req);
    if (!token) throw new UnauthorizedError();
    const payload = authService.verifyToken(token);
    const user = await repositories.users.findById(payload.sub);
    if (!user || !user.is_active) throw new UnauthorizedError('Account is no longer active');
    req.user = user;
    req.permissions = await repositories.users.permissionsFor(user.id);
    req.context.actor = {
      id: user.id,
      username: user.username,
      fullName: user.full_name,
      defaultWarehouseId: user.default_warehouse_id,
    };
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Route guard. `requirePermission('sales.create')`
 *
 * A route requiring `sales.create` belongs to the `sales` module by
 * construction, so this one check is also where module entitlements are
 * enforced — every present and future route is covered without a
 * hand-written URL-to-module table. The check runs against the *matched*
 * code, never `codes[0]`: a route that accepts several permissions (e.g.
 * `requirePermission('reports.view', 'sales.view')`) must not let an
 * enabled module's permission smuggle through access that was really
 * granted by a disabled one — that is exactly the bypass a naive
 * "check the first code's module" implementation would open.
 *
 * With no tenant resolved (the single-shop build), `currentTenant()` is
 * null and nothing about this changes at all.
 */
export const requirePermission = (...codes) => guard(codes, { enforceModule: true });

/**
 * The same guard with the module gate lifted, for the short reference lists
 * (`GET /brands/options`, `/categories/options`, …) that other modules are
 * built out of: a product form has to name a brand whether or not this shop
 * bought the brands screen, and a shop on a products-only plan that cannot
 * open the product form has not been sold a smaller ERP, it has been sold a
 * broken one. The RBAC check is untouched — only the entitlement is — and
 * these routes are read-only lists of the tenant's own data.
 */
export const requireLookup = (...codes) => guard(codes, { enforceModule: false });

function guard(codes, { enforceModule }) {
  return (req, _res, next) => {
  if (!req.permissions) return next(new UnauthorizedError());
  const granted = codes.filter((code) => req.permissions.includes(code));
  if (!granted.length) {
    return next(new ForbiddenError(`Missing permission: ${codes.join(' or ')}`));
  }

  const tenant = enforceModule ? currentTenant() : null;
  if (tenant) {
    const withEnabledModule = granted.find((code) => tenant.modules.has(code.split('.')[0]));
    if (!withEnabledModule) {
      const module = granted[0].split('.')[0];
      return next(new AppError(`This shop's plan does not include the "${module}" module`, {
        status: 403, code: 'MODULE_NOT_ENABLED', details: { module },
      }));
    }
  }

  return next();
  };
}

/** Zod-backed body validation. */
export const validate = (schema, source = 'body') => (req, _res, next) => {
  const result = schema.safeParse(req[source]);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    return next(new ValidationError('Please correct the highlighted fields', details));
  }
  req[source] = result.data;
  return next();
};

/** Wraps async handlers so rejected promises reach the error middleware. */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Serve stored photo bytes.
 *
 * The bytes behind an id never change — editing a photo means uploading a new
 * one, which gets a new id — so the response is immutable for a year and the
 * validator can be built from the row instead of hashing the payload on every
 * request. That is what keeps the shop's product grid off the database: after
 * the first paint the browser never asks again, and a browser that does ask
 * gets 304 and no bytes.
 *
 * `res.end()` rather than `res.send()`: send() would try to charset-tag the
 * body and generate an ETag of its own.
 *
 * ── Serving bytes that came from outside ────────────────────────────────────
 * The content type is the one SNIFFED out of the file when it was stored (see
 * shared/imageCodec.js), never the one the uploader declared — but a browser
 * will still second-guess a `Content-Type` it disagrees with, and a file that
 * is a valid JPEG *and* valid HTML is a real trick. `nosniff` takes that
 * decision away from it. `Content-Disposition: inline` and a `default-src
 * 'none'` policy are the belt to that brace: if anything ever did get served
 * as a document, it would be a document that can load nothing and run nothing.
 * Product photos, the banner and a photographed receipt are all bytes somebody
 * uploaded, so all three get this — it is set here rather than at each caller
 * for exactly that reason.
 */
export function sendImage(req, res, image, { cacheControl = 'public, max-age=31536000, immutable' } = {}) {
  const etag = `"img-${image.id}-${image.byte_size}-${image.created_at}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");

  const conditional = req.get('if-none-match');
  if (conditional && conditional.split(',').some((candidate) => candidate.trim() === etag)) {
    return res.status(304).end();
  }

  const body = Buffer.isBuffer(image.data) ? image.data : Buffer.from(image.data);
  res.setHeader('Content-Type', image.content_type || 'application/octet-stream');
  res.setHeader('Content-Length', body.length);
  return res.end(body);
}

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` } });
}

export function errorHandler(error, req, res, _next) {
  const isApp = error instanceof AppError;
  const status = isApp ? error.status : 500;

  if (!isApp) {
    // Translate SQLite constraint failures into something a shop user can act on.
    if (String(error.message).includes('UNIQUE constraint failed')) {
      return res.status(409).json({
        error: { code: 'CONFLICT', message: 'A record with this unique value already exists' },
      });
    }
    if (String(error.message).includes('FOREIGN KEY constraint failed')) {
      return res.status(409).json({
        error: { code: 'CONFLICT', message: 'This record is linked to other data and cannot be changed' },
      });
    }
    // eslint-disable-next-line no-console
    console.error(`[error] ${req.method} ${req.originalUrl}`, error);
  }

  const payload = {
    error: {
      code: isApp ? error.code : 'INTERNAL_ERROR',
      message: isApp ? error.message : 'Something went wrong on the server',
      details: isApp ? error.details : undefined,
    },
  };
  // The contract shape for this one code is `{ error: { code, module } }` —
  // `module` sits next to `code`, not buried in `details`, so the sidebar
  // can read it without knowing the general error envelope.
  if (isApp && error.code === 'MODULE_NOT_ENABLED' && error.details?.module) {
    payload.error.module = error.details.module;
  }
  res.status(status).json(payload);
}
