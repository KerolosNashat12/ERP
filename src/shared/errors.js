/** Typed application errors — the API layer maps these to HTTP status codes. */

export class AppError extends Error {
  constructor(message, { status = 400, code = 'APP_ERROR', details = null } = {}) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.details = details;
    this.isOperational = true;
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details = null) {
    super(message, { status: 422, code: 'VALIDATION_ERROR', details });
  }
}

export class NotFoundError extends AppError {
  constructor(entity = 'Record', id = null) {
    super(id ? `${entity} ${id} was not found` : `${entity} was not found`, {
      status: 404,
      code: 'NOT_FOUND',
    });
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflicting record') {
    super(message, { status: 409, code: 'CONFLICT' });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, { status: 401, code: 'UNAUTHORIZED' });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action') {
    super(message, { status: 403, code: 'FORBIDDEN' });
  }
}

export class BusinessRuleError extends AppError {
  constructor(message, details = null) {
    super(message, { status: 400, code: 'BUSINESS_RULE', details });
  }
}
