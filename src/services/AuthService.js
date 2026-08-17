/**
 * Authentication + session issuing.
 * Passwords are bcrypt-hashed; sessions are stateless JWTs stored in an
 * httpOnly cookie so the SPA works after a page refresh with no server state.
 */
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import config from '../config/index.js';
import repositories from '../infrastructure/repositories/index.js';
import { UnauthorizedError, ValidationError, ForbiddenError } from '../shared/errors.js';
import auditService from './AuditService.js';

export class AuthService {
  constructor(deps = {}) {
    this.users = deps.users || repositories.users;
    this.roles = deps.roles || repositories.roles;
    this.audit = deps.audit || auditService;
  }

  hashPassword(plain) {
    if (!plain || String(plain).length < 6) {
      throw new ValidationError('Password must be at least 6 characters long');
    }
    return bcrypt.hashSync(String(plain), config.auth.bcryptRounds);
  }

  issueToken(user) {
    return jwt.sign(
      { sub: user.id, username: user.username, role: user.role_code || null },
      config.auth.secret,
      { expiresIn: config.auth.tokenTtl },
    );
  }

  verifyToken(token) {
    try {
      return jwt.verify(token, config.auth.secret);
    } catch {
      throw new UnauthorizedError('Session expired, please sign in again');
    }
  }

  async login({ username, password }, request = {}) {
    const user = await this.users.findByUsername(username);
    if (!user) {
      await this.audit.record({
        action: 'LOGIN', module: 'users', status: 'FAILED',
        message: `Unknown username "${username}"`, request,
        actor: { id: null, username },
      });
      throw new UnauthorizedError('Invalid username or password');
    }

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      await this.audit.record({
        action: 'LOGIN', module: 'users', status: 'BLOCKED',
        message: 'Attempt on a locked account', request,
        actor: { id: user.id, username: user.username },
      });
      throw new ForbiddenError('Account temporarily locked after repeated failed attempts');
    }

    if (!user.is_active) {
      await this.audit.record({
        action: 'LOGIN', module: 'users', status: 'BLOCKED',
        message: 'Attempt on a deactivated account', request,
        actor: { id: user.id, username: user.username },
      });
      throw new ForbiddenError('This account is deactivated');
    }

    if (!bcrypt.compareSync(String(password || ''), user.password_hash)) {
      const { attempts, lockedUntil } = await this.users.registerLoginFailure(
        user.id, config.auth.maxFailedAttempts, config.auth.lockMinutes,
      );
      await this.audit.record({
        action: 'LOGIN', module: 'users', status: 'FAILED',
        message: `Wrong password (attempt ${attempts}${lockedUntil ? ', account locked' : ''})`,
        request, actor: { id: user.id, username: user.username },
      });
      throw new UnauthorizedError('Invalid username or password');
    }

    await this.users.registerLoginSuccess(user.id);
    const profile = await this.profile(user.id);
    await this.audit.record({
      action: 'LOGIN', module: 'users', entityType: 'user', entityId: user.id,
      entityLabel: user.username, request, actor: { id: user.id, username: user.username },
    });
    return { token: this.issueToken({ ...user, role_code: profile.role.code }), user: profile };
  }

  async logout(actor, request) {
    await this.audit.record({
      action: 'LOGOUT', module: 'users', entityType: 'user', entityId: actor?.id,
      entityLabel: actor?.username, actor, request,
    });
  }

  /** Full session profile: identity, role, permission codes, default warehouse. */
  async profile(userId) {
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedError('Account no longer exists');
    const role = await this.roles.findById(user.role_id);
    return {
      id: user.id,
      username: user.username,
      fullName: user.full_name,
      email: user.email,
      phone: user.phone,
      language: user.language,
      isActive: Boolean(user.is_active),
      mustChangePassword: Boolean(user.must_change_password),
      defaultWarehouseId: user.default_warehouse_id,
      lastLoginAt: user.last_login_at,
      role: role
        ? { id: role.id, code: role.code, nameEn: role.name_en, nameAr: role.name_ar }
        : null,
      permissions: await this.users.permissionsFor(user.id),
    };
  }

  async changePassword(userId, { currentPassword, newPassword }, context = {}) {
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedError();
    if (!bcrypt.compareSync(String(currentPassword || ''), user.password_hash)) {
      throw new ValidationError('Current password is incorrect');
    }
    await this.users.update(userId, {
      password_hash: this.hashPassword(newPassword),
      must_change_password: 0,
    });
    await this.audit.record({
      action: 'PASSWORD_CHANGE', module: 'users', entityType: 'user', entityId: userId,
      entityLabel: user.username, actor: context.actor, request: context.request,
    });
    return { changed: true };
  }

  async updatePreferences(userId, { language }, context = {}) {
    if (language && !['en', 'ar'].includes(language)) throw new ValidationError('Unsupported language');
    await this.users.update(userId, { language });
    await this.audit.record({
      action: 'UPDATE', module: 'users', entityType: 'user_preferences', entityId: userId,
      entityLabel: context.actor?.username, after: { language },
      actor: context.actor, request: context.request,
    });
    return this.profile(userId);
  }
}

export const authService = new AuthService();
export default authService;
