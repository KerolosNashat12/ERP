/** Cross-cutting HTTP concerns: auth, RBAC, request context, error mapping. */
import config from '../../config/index.js';
import authService from '../../services/AuthService.js';
import repositories from '../../infrastructure/repositories/index.js';
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

/** Route guard. `requirePermission('sales.create')` */
export const requirePermission = (...codes) => (req, _res, next) => {
  if (!req.permissions) return next(new UnauthorizedError());
  const granted = codes.some((code) => req.permissions.includes(code));
  if (!granted) {
    return next(new ForbiddenError(`Missing permission: ${codes.join(' or ')}`));
  }
  return next();
};

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

  res.status(status).json({
    error: {
      code: isApp ? error.code : 'INTERNAL_ERROR',
      message: isApp ? error.message : 'Something went wrong on the server',
      details: isApp ? error.details : undefined,
    },
  });
}
