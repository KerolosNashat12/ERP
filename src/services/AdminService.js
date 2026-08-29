/**
 * User administration, role permissions, application settings and the
 * offline backup/restore workflow.
 */
import fs from 'node:fs';
import path from 'node:path';
import repositories from '../infrastructure/repositories/index.js';
import {
  getDb, transaction, backupTo, supportsFileBackup, driverName, currentTenant, currentTenantSlug,
} from '../infrastructure/database/connection.js';
import config from '../config/index.js';
import {
  AppError, BusinessRuleError, ConflictError, ForbiddenError, NotFoundError, ValidationError,
} from '../shared/errors.js';
import { ALL_PERMISSIONS, UNDELEGATABLE } from '../shared/permissions.js';
import { normalizeHexColor, booleanOr, TEMPLATES } from '../shared/branding.js';
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

      /*
       * Nobody promotes themselves.
       *
       * `UNDELEGATABLE` stops a role being GRANTED certain permissions, and
       * that guard was walkable in two hops: a user trusted with `users.update`
       * opened their own record and set their role to Administrator, which
       * holds everything the list was protecting. The whole point of delegating
       * user administration is that it does not hand over the shop.
       *
       * Changing anything else about yourself - your name, your phone, your
       * language - is unaffected. So is an administrator moving somebody ELSE
       * between roles, which is what this right is for.
       */
      if (payload.role_id
          && Number(payload.role_id) !== Number(before.role_id)
          && Number(context.actor?.id) === Number(id)) {
        throw new ForbiddenError(
          'You cannot change your own role — ask another administrator',
          { rule: 'role_self_change' },
        );
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

  /**
   * A role's permissions, with one code the editor cannot hand out.
   *
   * `settings.export_data` produces one file holding every salary and every
   * customer's phone number, and a role editor is where that gets ticked by
   * accident. See `UNDELEGATABLE` in shared/permissions.js for the whole
   * argument; the refusal carries a code so the screen can say it in Arabic.
   */
  async updateRolePermissions(roleId, permissions, context = {}) {
    return transaction(async () => {
      const role = await this.roleRepository.requireById(roleId, 'role');
      if (role.code === 'admin') throw new BusinessRuleError('The administrator role always keeps every permission');

      const forbidden = (permissions || []).filter((code) => UNDELEGATABLE.has(code));
      if (forbidden.length) {
        throw new AppError(
          `"${forbidden.join('", "')}" cannot be given to a role. Taking a copy of the whole `
          + 'shop belongs to an administrator; make this person an administrator instead.',
          { status: 422, code: 'PERMISSION_NOT_DELEGATABLE', details: { codes: forbidden } },
        );
      }
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
  // Which of the two storefronts this shop wears. The list is imported rather
  // than repeated: a third template added in shared/branding.js has to become
  // savable here on the same commit, and a hand-copied array is how it would
  // not. See TEMPLATES there.
  'web.template': TEMPLATES,
  'web.banner_align': ['right', 'center', 'left'],
  'web.banner_valign': ['top', 'middle', 'bottom'],
  'web.banner_text_size': ['small', 'medium', 'large'],
  'web.banner_text_color': ['light', 'dark'],
  // The figures band under the banner. Stored as the string a <select> sends;
  // the storefront reads it through the same tolerant test it uses for every
  // other on/off setting, so a hand-edited 'true' still works.
  'web.stats_enabled': ['0', '1'],
  'shop.delivery_mode': ['flat', 'percent'],
};

/** Settings that must be a number within [min, max]. Same reasoning as above. */
const SETTING_RANGES = {
  'web.banner_box_width': [30, 100],
  'shop.delivery_percent': [0, 100],
};

/**
 * Settings that must be a hex colour. The storefront applies this one to
 * `<html>` as a CSS custom property that buttons, links, prices and active
 * states all derive from, so a typo is not a shade nobody likes — it is a page
 * with no accent colour at all.
 *
 * Refusing it here is the half that tells somebody. `buildBranding()` refuses
 * it again on the read path, which is the half that keeps a hand-edited row or
 * a restored backup off the page; neither is enough on its own.
 *
 * Empty is allowed and means "unset": the read path answers with the default.
 */
const SETTING_COLOURS = new Set(['web.theme_accent']);

/**
 * Settings stored as a real boolean rather than as whatever the ERP form sent.
 * `'0'` is a non-empty string, and a string is truthy — a checkbox saved as
 * text would read as `true` for ever after, in a dark-mode switch nobody could
 * turn off.
 */
const SETTING_BOOLEANS = new Set(['web.theme_dark']);

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
    if (SETTING_COLOURS.has(key) && String(value ?? '').trim() !== ''
      && normalizeHexColor(value) === null) {
      throw new ValidationError(
        `${key} must be a hex colour such as #c8a24a`, { key, value },
      );
    }
  }

  /**
   * What actually gets stored. Only the keys above are touched — everything
   * else is written exactly as the ERP sent it, as it always has been.
   * `#000` and `#000000` are the same colour and must not be two rows' worth
   * of difference to anything reading them back.
   */
  #normalize(key, value) {
    if (SETTING_COLOURS.has(key)) {
      return String(value ?? '').trim() === '' ? '' : normalizeHexColor(value);
    }
    if (SETTING_BOOLEANS.has(key)) return booleanOr(value, true);
    return value;
  }

  async update(values, context = {}) {
    return transaction(async () => {
      for (const [key, value] of Object.entries(values || {})) {
        this.#assertValid(key, value);
      }
      const before = await this.settings.asObject();
      for (const [key, value] of Object.entries(values || {})) {
        await this.settings.set(key, this.#normalize(key, value));
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

  /**
   * WHERE this shop's file backups live — and the answer is never "the same
   * folder as everybody else's".
   *
   * This class knew nothing about tenants. Every shop on a fleet wrote its
   * `mm-backup-<timestamp>.db` into one shared directory, and `list()` and the
   * download route then read that whole directory back: shop B's administrator
   * opened Settings, saw shop A's backup sitting there, and could download it.
   * That file is the entire other shop - its prices, its costs, its customers,
   * its payroll.
   *
   * A folder per slug fixes it at the only level that actually holds: not by
   * filtering names, which the next filename format would defeat, but by never
   * putting two shops' files in one place. A single-shop deployment keeps the
   * folder it has always used, so nothing on a shop PC moves.
   */
  #dir() {
    const slug = currentTenantSlug();
    const dir = slug ? path.join(config.paths.backups, slug) : config.paths.backups;
    return dir;
  }

  list() {
    const dir = this.#dir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.db'))
      .map((file) => {
        const stat = fs.statSync(path.join(dir, file));
        return { file, size: stat.size, createdAt: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Only the local file driver can hand us a copy on disk. On a hosted database
   * we must refuse loudly: a truncated or missing file in the backups folder
   * would pass for a real backup right up to the day someone needed it.
   *
   * ── What this message used to say, and why it was wrong twice ──────────────
   * It used to end "…where backups and restores are handled by the database
   * provider", in English, on a screen that is in Arabic — and it told a shop
   * owner that he could not have a copy of his own data, which was untrue the
   * day it was written and is flatly untrue now: `DataExportService` builds the
   * whole book, on every deployment, from the same machinery the console uses.
   *
   * So this refusal is now narrow and honest. It is ONLY about copying the
   * database FILE — a thing that exists on a shop PC and does not exist on a
   * hosted database — and it carries a code so the screen says it in the
   * language the person is reading. The screen never shows this card on a
   * hosted deployment anyway; this is what an API caller gets.
   */
  #assertFileBackupSupported(action) {
    if (supportsFileBackup()) return;
    throw new AppError(
      `${action} is not available here: this shop's database runs on ${driverName()}, `
      + 'which has no file to copy. Use "Download a copy of your data" instead — it '
      + 'produces the whole shop, spreadsheets included, on every deployment.',
      {
        status: 400,
        code: 'FILE_BACKUP_UNAVAILABLE',
        details: { driver: driverName(), useInstead: 'settings.export_data' },
      },
    );
  }

  /** Consistent copy taken with VACUUM INTO — safe while the shop is trading. */
  async create(context = {}) {
    this.#assertFileBackupSupported('Creating a backup');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = `mm-backup-${stamp}.db`;
    const dir = this.#dir();
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, file);
    await backupTo(target);
    const stat = fs.statSync(target);
    await this.audit.record({
      action: 'BACKUP', module: 'settings', entityType: 'backup', entityLabel: file,
      after: { file, size: stat.size }, actor: context.actor, request: context.request,
    });
    return { file, size: stat.size, createdAt: stat.mtime.toISOString(), path: target };
  }

  /*
   * `basename` strips any traversal, and the folder it is joined to is this
   * shop's own - so a name cannot reach another shop's file even if it is
   * guessed exactly right.
   */
  resolve(file) {
    const safe = path.basename(String(file));
    const target = path.join(this.#dir(), safe);
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
    /*
     * Refused on a fleet, deliberately.
     *
     * This method copies a file over `config.paths.database` - the PROCESS
     * default database, which on a platform deployment is not the shop asking.
     * A tenant administrator pressing restore would have overwritten a
     * different shop's data with their own backup. Rather than guess at a
     * tenant's file path here, the operation is refused and pointed at the
     * console's restore, which is per-tenant, actor-bound and single-use.
     *
     * A shop on its own PC has no tenant in scope and is unaffected: this is
     * the deployment the feature was written for and it still works exactly as
     * it did.
     */
    if (currentTenantSlug()) {
      throw new AppError(
        'Restoring a backup is done from the owner console on this deployment, '
        + 'so it can be aimed at exactly one shop.',
        { status: 400, code: 'FILE_BACKUP_UNAVAILABLE', details: { reason: 'multi_tenant' } },
      );
    }
    const source = this.resolve(file);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const preRestore = path.join(this.#dir(), `pre-restore-${stamp}.db`);
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
