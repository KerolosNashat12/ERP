/**
 * User administration, role permissions, application settings and the
 * offline backup/restore workflow.
 */
import fs from 'node:fs';
import path from 'node:path';
import repositories from '../infrastructure/repositories/index.js';
import { getDb, transaction, backupTo } from '../infrastructure/database/connection.js';
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

  list(query) {
    return { rows: this.users.listDetailed(query || {}) };
  }

  get(id) {
    const user = this.users.requireById(id, 'user');
    const { password_hash: _ignored, ...safe } = user;
    return { ...safe, permissions: this.users.permissionsFor(id) };
  }

  create(data, context = {}) {
    return transaction(() => {
      const username = String(data.username || '').trim().toLowerCase();
      if (!username) throw new ValidationError('Username is required');
      if (this.users.findByUsername(username)) throw new ConflictError(`Username "${username}" already exists`);
      this.roleRepository.requireById(data.role_id, 'role');

      const created = this.users.create({
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
      this.audit.record({
        action: 'CREATE', module: 'users', entityType: 'user', entityId: created.id,
        entityLabel: created.username,
        after: { username: created.username, full_name: created.full_name, role_id: created.role_id },
        actor: context.actor, request: context.request,
      });
      return this.get(created.id);
    });
  }

  update(id, data, context = {}) {
    return transaction(() => {
      const before = this.users.requireById(id, 'user');
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
        this.#assertNotLastAdmin(before);
      }

      const after = this.users.update(id, payload);
      this.audit.recordChange(context, {
        action: 'UPDATE', module: 'users', entityType: 'user', entityId: id,
        entityLabel: after.username,
        before: { ...before, password_hash: undefined },
        after: { ...after, password_hash: undefined },
      });
      return this.get(id);
    });
  }

  remove(id, context = {}) {
    return transaction(() => {
      const user = this.users.requireById(id, 'user');
      this.#assertNotLastAdmin(user);
      const hasActivity = Boolean(getDb()
        .prepare('SELECT 1 FROM audit_logs WHERE user_id = ? LIMIT 1').get(id));
      if (hasActivity) {
        const after = this.users.update(id, { is_active: 0 });
        this.audit.record({
          action: 'DEACTIVATE', module: 'users', entityType: 'user', entityId: id,
          entityLabel: user.username, actor: context.actor, request: context.request,
        });
        return { deleted: false, deactivated: true, user: after };
      }
      this.users.remove(id);
      this.audit.record({
        action: 'DELETE', module: 'users', entityType: 'user', entityId: id,
        entityLabel: user.username, actor: context.actor, request: context.request,
      });
      return { deleted: true };
    });
  }

  #assertNotLastAdmin(user) {
    const adminRole = this.roleRepository.findBy('code', 'admin');
    if (!adminRole || user.role_id !== adminRole.id) return;
    const remaining = getDb()
      .prepare('SELECT COUNT(*) AS n FROM users WHERE role_id = ? AND is_active = 1 AND id <> ?')
      .get(adminRole.id, user.id).n;
    if (remaining === 0) {
      throw new BusinessRuleError('At least one active administrator must remain');
    }
  }

  roles() {
    return this.roleRepository.withPermissions();
  }

  permissionCatalogue() {
    return ALL_PERMISSIONS;
  }

  updateRolePermissions(roleId, permissions, context = {}) {
    return transaction(() => {
      const role = this.roleRepository.requireById(roleId, 'role');
      if (role.code === 'admin') throw new BusinessRuleError('The administrator role always keeps every permission');
      const before = this.roleRepository.withPermissions().find((r) => r.id === roleId)?.permissions || [];
      this.roleRepository.setPermissions(roleId, permissions);
      this.audit.record({
        action: 'UPDATE', module: 'users', entityType: 'role', entityId: roleId,
        entityLabel: role.name_en, before: { permissions: before }, after: { permissions },
        actor: context.actor, request: context.request,
      });
      return this.roleRepository.withPermissions().find((r) => r.id === roleId);
    });
  }
}

export class SettingsService {
  constructor(deps = {}) {
    this.settings = deps.settings || repositories.settings;
    this.audit = deps.audit || auditService;
  }

  all() {
    return this.settings.asObject();
  }

  update(values, context = {}) {
    return transaction(() => {
      const before = this.settings.asObject();
      for (const [key, value] of Object.entries(values || {})) {
        this.settings.set(key, value);
      }
      const after = this.settings.asObject();
      this.audit.recordChange(context, {
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

  /** Consistent copy taken with VACUUM INTO — safe while the shop is trading. */
  create(context = {}) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = `mm-backup-${stamp}.db`;
    const target = path.join(config.paths.backups, file);
    backupTo(target);
    const stat = fs.statSync(target);
    this.audit.record({
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

  remove(file, context = {}) {
    const target = this.resolve(file);
    fs.unlinkSync(target);
    this.audit.record({
      action: 'DELETE', module: 'settings', entityType: 'backup', entityLabel: path.basename(target),
      actor: context.actor, request: context.request,
    });
    return { deleted: true };
  }

  /**
   * Restore: the current database is archived first, then replaced. The process
   * must be restarted afterwards, which the API response makes explicit.
   */
  restore(file, context = {}) {
    const source = this.resolve(file);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const preRestore = path.join(config.paths.backups, `pre-restore-${stamp}.db`);
    fs.copyFileSync(config.paths.database, preRestore);
    this.audit.record({
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
