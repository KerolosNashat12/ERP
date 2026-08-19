/**
 * User administration, role permissions, application settings and the
 * offline backup/restore workflow.
 */
import fs from 'node:fs';
import path from 'node:path';
import repositories from '../infrastructure/repositories/index.js';
import {
  getDb, transaction, backupTo, supportsFileBackup, driverName, currentTenant,
} from '../infrastructure/database/connection.js';
import config from '../config/index.js';
import { BusinessRuleError, ConflictError, NotFoundError, ValidationError } from '../shared/errors.js';
import { ALL_PERMISSIONS } from '../shared/permissions.js';
import authService from './AuthService.js';
import auditService from './AuditService.js';

export class UserService {
  constructor(deps = {}) {
    this.users = deps.users || repositories.users;
    this.roleRepository = deps.roles || repositories.roles;
    this.auth = deps.auth || authService;
    this.audit = deps.audit || auditService;
  }

  async list(query) {
    return { rows: await this.users.listDetailed(query || {}) };
  }

  async get(id) {
    const user = await this.users.requireById(id, 'user');
    const { password_hash: _ignored, ...safe } = user;
    return { ...safe, permissions: await this.users.permissionsFor(id) };
  }

  /**
   * `max_users` (0 = unlimited) counts every row in the tenant's own `users`
   * table, active or not — a deactivated account still occupies a seat the
   * owner is paying for, so it stays in the count. Checked here rather than
   * at the repository layer because only a *new* user should ever trip it;
   * editing or reactivating an existing one must not.
   */
  async #assertUserSeatAvailable() {
    const tenant = currentTenant();
    const maxUsers = tenant?.limits?.maxUsers;
    if (!tenant || !maxUsers) return;
    const { n: count } = await getDb().prepare('SELECT COUNT(*) AS n FROM users').get();
    if (count >= maxUsers) {
      throw new BusinessRuleError(
        `This shop is limited to ${maxUsers} user(s) and already has ${count} `
        + '(inactive accounts still count — they still occupy a seat)',
        { limit: 'max_users', max: maxUsers, count },
      );
    }
  }

  async create(data, context = {}) {
    return transaction(async () => {
      await this.#assertUserSeatAvailable();
      const username = String(data.username || '').trim().toLowerCase();
      if (!username) throw new ValidationError('Username is required');
      if (await this.users.findByUsername(username)) throw new ConflictError(`Username "${username}" already exists`);
      await this.roleRepository.requireById(data.role_id, 'role');

      const created = await this.users.create({
        username,
        full_name: data.full_name,
        email: data.email || null,
        phone: data.phone || null,
        password_hash: this.auth.hashPassword(data.password),
        role_id: data.role_id,
        default_warehouse_id: data.default_warehouse_id || null,
        language: data.language || 'en',
        is_active: data.is_active === false ? 0 : 1,
        must_change_password: data.must_change_password ? 1 : 0,
        created_by: context.actor?.id || null,
      });
      await this.audit.record({
        action: 'CREATE', module: 'users', entityType: 'user', entityId: created.id,
        entityLabel: created.username,
        after: { username: created.username, full_name: created.full_name, role_id: created.role_id },
        actor: context.actor, request: context.request,
      });
      return this.get(created.id);
    });
  }

  async update(id, data, context = {}) {
    return transaction(async () => {
      const before = await this.users.requireById(id, 'user');
      const payload = {
        full_name: data.full_name,
        email: data.email,
        phone: data.phone,
        role_id: data.role_id,
        default_warehouse_id: data.default_warehouse_id,
        language: data.language,
        is_active: data.is_active === undefined ? undefined : (data.is_active ? 1 : 0),
      };
      if (data.password) payload.password_hash = this.auth.hashPassword(data.password);
      if (data.unlock) { payload.locked_until = null; payload.failed_attempts = 0; }

      // Protect the last administrator from being locked out of the system.
      if (payload.is_active === 0 || (payload.role_id && payload.role_id !== before.role_id)) {
        await this.#assertNotLastAdmin(before);
      }

      const after = await this.users.update(id, payload);
      await this.audit.recordChange(context, {
        action: 'UPDATE', module: 'users', entityType: 'user', entityId: id,
        entityLabel: after.username,
        before: { ...before, password_hash: undefined },
        after: { ...after, password_hash: undefined },
      });
      return this.get(id);
    });
  }

  async remove(id, context = {}) {
    return transaction(async () => {
      const user = await this.users.requireById(id, 'user');
      await this.#assertNotLastAdmin(user);
      const hasActivity = Boolean(await getDb()
        .prepare('SELECT 1 FROM audit_logs WHERE user_id = ? LIMIT 1').get(id));
      if (hasActivity) {
        const after = await this.users.update(id, { is_active: 0 });
        await this.audit.record({
          action: 'DEACTIVATE', module: 'users', entityType: 'user', entityId: id,
          entityLabel: user.username, actor: context.actor, request: context.request,
        });
        return { deleted: false, deactivated: true, user: after };
      }
      await this.users.remove(id);
      await this.audit.record({
        action: 'DELETE', module: 'users', entityType: 'user', entityId: id,
        entityLabel: user.username, actor: context.actor, request: context.request,
      });
      return { deleted: true };
    });
  }

  async #assertNotLastAdmin(user) {
    const adminRole = await this.roleRepository.findBy('code', 'admin');
    if (!adminRole || user.role_id !== adminRole.id) return;
    const remaining = (await getDb()
      .prepare('SELECT COUNT(*) AS n FROM users WHERE role_id = ? AND is_active = 1 AND id <> ?')
      .get(adminRole.id, user.id)).n;
    if (remaining === 0) {
      throw new BusinessRuleError('At least one active administrator must remain');
    }
  }

  async roles() {
    return this.roleRepository.withPermissions();
  }

  permissionCatalogue() {
    return ALL_PERMISSIONS;
  }

  async updateRolePermissions(roleId, permissions, context = {}) {
    return transaction(async () => {
      const role = await this.roleRepository.requireById(roleId, 'role');
      if (role.code === 'admin') throw new BusinessRuleError('The administrator role always keeps every permission');
      const before = (await this.roleRepository.withPermissions())
        .find((r) => r.id === roleId)?.permissions || [];
      await this.roleRepository.setPermissions(roleId, permissions);
      await this.audit.record({
        action: 'UPDATE', module: 'users', entityType: 'role', entityId: roleId,
        entityLabel: role.name_en, before: { permissions: before }, after: { permissions },
        actor: context.actor, request: context.request,
      });
      return (await this.roleRepository.withPermissions()).find((r) => r.id === roleId);
    });
  }
}

/**
 * Settings that must be one of a fixed set of values. A typo here is not a
 * shop preference, it is a broken storefront — `enumOr()` in
 * StorefrontService would silently paper over it with the documented default,
 * which hides the mistake instead of catching it at the one moment (the ERP
 * save) where someone is looking.
 */
const SETTING_ENUMS = {
  'web.banner_align': ['right', 'center', 'left'],
  'web.banner_valign': ['top', 'middle', 'bottom'],
  'web.banner_text_size': ['small', 'medium', 'large'],
  'web.banner_text_color': ['light', 'dark'],
  'shop.delivery_mode': ['flat', 'percent'],
};

/** Settings that must be a number within [min, max]. Same reasoning as above. */
const SETTING_RANGES = {
  'web.banner_box_width': [30, 100],
  'shop.delivery_percent': [0, 100],
};

export class SettingsService {
  constructor(deps = {}) {
    this.settings = deps.settings || repositories.settings;
    this.audit = deps.audit || auditService;
  }

  async all() {
    return this.settings.asObject();
  }

  /** Throws ValidationError (422) the moment one bad value is found. */
  #assertValid(key, value) {
    const allowed = SETTING_ENUMS[key];
    if (allowed && !allowed.includes(value)) {
      throw new ValidationError(
        `${key} must be one of: ${allowed.join(', ')}`, { key, value, allowed },
      );
    }
    const range = SETTING_RANGES[key];
    if (range) {
      const [min, max] = range;
      const n = Number(value);
      if (!Number.isFinite(n) || n < min || n > max) {
        throw new ValidationError(`${key} must be a number between ${min} and ${max}`, { key, value, min, max });
      }
    }
  }

  async update(values, context = {}) {
    return transaction(async () => {
      for (const [key, value] of Object.entries(values || {})) {
        this.#assertValid(key, value);
      }
      const before = await this.settings.asObject();
      for (const [key, value] of Object.entries(values || {})) {
        await this.settings.set(key, value);
      }
      const after = await this.settings.asObject();
      await this.audit.recordChange(context, {
        action: 'UPDATE', module: 'settings', entityType: 'settings',
        entityId: 'global', entityLabel: 'Application settings', before, after,
      });
      return after;
    });
  }
}

export class BackupService {
  constructor(deps = {}) {
    this.audit = deps.audit || auditService;
  }

  list() {
    if (!fs.existsSync(config.paths.backups)) return [];
    return fs.readdirSync(config.paths.backups)
      .filter((f) => f.endsWith('.db'))
      .map((file) => {
        const stat = fs.statSync(path.join(config.paths.backups, file));
        return { file, size: stat.size, createdAt: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Only the local file driver can hand us a copy on disk. On a hosted database
   * we must refuse loudly: a truncated or missing file in the backups folder
   * would pass for a real backup right up to the day someone needed it.
   */
  #assertFileBackupSupported(action) {
    if (supportsFileBackup()) return;
    throw new BusinessRuleError(
      `${action} is not available on this deployment: the database runs on ${driverName()}, `
      + 'where backups and restores are handled by the database provider.',
    );
  }

  /** Consistent copy taken with VACUUM INTO — safe while the shop is trading. */
  async create(context = {}) {
    this.#assertFileBackupSupported('Creating a backup');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = `mm-backup-${stamp}.db`;
    const target = path.join(config.paths.backups, file);
    await backupTo(target);
    const stat = fs.statSync(target);
    await this.audit.record({
      action: 'BACKUP', module: 'settings', entityType: 'backup', entityLabel: file,
      after: { file, size: stat.size }, actor: context.actor, request: context.request,
    });
    return { file, size: stat.size, createdAt: stat.mtime.toISOString(), path: target };
  }

  resolve(file) {
    const safe = path.basename(String(file));
    const target = path.join(config.paths.backups, safe);
    if (!fs.existsSync(target)) throw new NotFoundError('Backup file', safe);
    return target;
  }

  async remove(file, context = {}) {
    const target = this.resolve(file);
    fs.unlinkSync(target);
    await this.audit.record({
      action: 'DELETE', module: 'settings', entityType: 'backup', entityLabel: path.basename(target),
      actor: context.actor, request: context.request,
    });
    return { deleted: true };
  }

  /**
   * Restore: the current database is archived first, then replaced. The process
   * must be restarted afterwards, which the API response makes explicit.
   */
  async restore(file, context = {}) {
    this.#assertFileBackupSupported('Restoring a backup');
    const source = this.resolve(file);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const preRestore = path.join(config.paths.backups, `pre-restore-${stamp}.db`);
    fs.copyFileSync(config.paths.database, preRestore);
    await this.audit.record({
      action: 'RESTORE', module: 'settings', entityType: 'backup',
      entityLabel: path.basename(source),
      after: { restored_from: path.basename(source), safety_copy: path.basename(preRestore) },
      actor: context.actor, request: context.request,
    });
    fs.copyFileSync(source, config.paths.database);
    return { restored: true, safetyCopy: path.basename(preRestore), restartRequired: true };
  }
}

export const userService = new UserService();
export const settingsService = new SettingsService();
export const backupService = new BackupService();
